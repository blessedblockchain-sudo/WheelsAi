"""One training run, start to finish.

    config -> download dataset -> load base model -> tokenize -> train
           -> save adapter -> upload adapter and metrics -> completed

`main` turns whatever happens into one exit code and one terminal event.
Nothing here knows what a run costs or who pays for a failure: it reports
the exit code, a `code` string, the phase and the facts, and stops.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import json
import math
import os
import platform
import random
import shutil
import signal
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Mapping

from . import METRICS_SCHEMA_VERSION, TRAINER_VERSION
from .callbacks import CallbackSender
from .config import ALL_LINEAR, TrainerConfig, load_config
from .data import build_examples, collate, resolve_pad_token_id, split_examples
from .errors import (
    EXIT_INTERRUPTED,
    EXIT_OK,
    EXIT_OUT_OF_MEMORY,
    EXIT_UNEXPECTED,
    BaseModelError,
    ConfigError,
    DivergedError,
    Interrupted,
    TrainerError,
)
from .events import EventEmitter, redact
from .upload import (
    ADAPTER_ARCHIVE_NAME,
    ADAPTER_CONTENT_TYPE,
    METRICS_CONTENT_TYPE,
    download_dataset,
    pack_adapter,
    put_file,
)

DEFAULT_WORK_DIR = "/workspace"
GRADIENT_CLIP_NORM = 1.0
# Points kept in metrics.json per loss curve; longer runs are thinned evenly.
MAX_CURVE_POINTS = 1000
# Steps averaged for finalTrainLoss: one step's loss is mostly noise.
FINAL_LOSS_WINDOW = 10
CHECKPOINT_STATE_FILE = "trainer_state.pt"
CHECKPOINT_VERSION = 1
LIBRARIES = ("torch", "transformers", "peft", "accelerate", "tokenizers", "safetensors", "bitsandbytes")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def library_versions() -> dict:
    versions = {"python": platform.python_version(), "trainer": TRAINER_VERSION}
    for name in LIBRARIES:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def resolve_device(requested: str) -> str:
    import torch

    if requested == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if requested == "cuda":
        raise ConfigError("--device cuda was asked for but no CUDA GPU is visible", code="cuda_unavailable")
    return "cpu"


def gpu_facts(device: str) -> dict:
    import torch

    if device != "cuda":
        return {"name": None, "vramGb": None}
    properties = torch.cuda.get_device_properties(0)
    return {"name": properties.name, "vramGb": round(properties.total_memory / 2**30, 2)}


def runtime_reserve_seconds(max_runtime_seconds: int) -> float:
    """Time kept back from MAX_RUNTIME_SECONDS for the last evaluation, the
    save and the upload, so a run that reaches its limit still hands over
    the adapter it has."""
    return min(300.0, max(30.0, 0.1 * max_runtime_seconds))


def thin(points: list, limit: int = MAX_CURVE_POINTS) -> list:
    """Evenly drop points beyond `limit`, always keeping the last one."""
    if len(points) <= limit:
        return points
    stride = math.ceil(len(points) / limit)
    kept = points[::stride]
    if kept[-1] is not points[-1]:
        kept.append(points[-1])
    return kept


def is_out_of_memory(error: BaseException) -> str | None:
    """The `code` for an out-of-memory error, or None for anything else."""
    import torch

    if isinstance(error, torch.cuda.OutOfMemoryError):
        return "gpu_out_of_memory"
    if isinstance(error, RuntimeError) and "out of memory" in str(error).lower():
        return "gpu_out_of_memory"
    if isinstance(error, MemoryError):
        return "host_out_of_memory"
    return None


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


def _base_model_error(error: Exception, has_token: bool) -> BaseModelError:
    """Name why the base model did not load. The Hub's own exception types
    are looked for first, anywhere in the cause chain, because transformers
    rewraps them as OSError with a paragraph of advice."""
    from huggingface_hub import errors as hub

    chain = []
    seen = error
    while seen is not None and seen not in chain:
        chain.append(seen)
        seen = seen.__cause__ or seen.__context__
    text = " ".join(str(link) for link in chain).lower()

    def any_of(*types) -> bool:
        return any(isinstance(link, types) for link in chain)

    if any_of(hub.GatedRepoError) or "gated repo" in text:
        hint = "" if has_token else " No HF_TOKEN was provided."
        return BaseModelError(
            f"The base model is gated on Hugging Face and this run may not read it.{hint}",
            code="base_model_gated",
        )
    if any_of(hub.LocalEntryNotFoundError, hub.OfflineModeIsEnabled) or "couldn't connect" in text:
        return BaseModelError(
            "The base model could not be downloaded from Hugging Face", code="base_model_download_failed"
        )
    if (
        any_of(hub.RepositoryNotFoundError, hub.EntryNotFoundError, hub.RevisionNotFoundError)
        # HFValidationError: neither a folder on disk nor a well-formed Hub id.
        or any_of(hub.HFValidationError)
        or "not a valid model identifier" in text
        or "not a local folder" in text
        or "does not appear to have a file named" in text
    ):
        hint = "" if has_token else " If it is private, an HF_TOKEN is needed."
        return BaseModelError(f"The base model was not found.{hint}", code="base_model_not_found")
    return BaseModelError(
        f"The base model could not be loaded: {type(error).__name__}: {error}",
        code="base_model_load_failed",
    )


def load_tokenizer_and_model(cfg: TrainerConfig, device: str):
    """Load the tokenizer and the base model. trust_remote_code stays off:
    a job must not be able to run code from a model repository."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    common = {"token": cfg.hf_token, "trust_remote_code": False}
    try:
        tokenizer = AutoTokenizer.from_pretrained(cfg.base_model, **common)
        if cfg.method == "qlora":
            from transformers import BitsAndBytesConfig

            quantization = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=torch.bfloat16,
            )
            model = AutoModelForCausalLM.from_pretrained(
                cfg.base_model,
                quantization_config=quantization,
                device_map={"": 0},
                torch_dtype=torch.bfloat16,
                **common,
            )
        else:
            dtype = torch.bfloat16 if device == "cuda" else torch.float32
            model = AutoModelForCausalLM.from_pretrained(cfg.base_model, torch_dtype=dtype, **common)
            model.to(device)
    except (OSError, ValueError, ImportError, KeyError) as error:
        raise _base_model_error(error, has_token=bool(cfg.hf_token))
    return tokenizer, model


def apply_lora(model, cfg: TrainerConfig):
    """Wrap the base model with LoRA weights.

    No modules_to_save and no embedding training: the adapter is two files,
    adapter_config.json and adapter_model.safetensors, holding lora_A and
    lora_B matrices only, which is what vLLM --lora-modules loads.
    """
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    hp = cfg.hyperparams
    if cfg.method == "qlora":
        # Casts the norms to fp32 and turns gradient checkpointing on, which
        # is what lets a 7-8B model train in 24 GB.
        model = prepare_model_for_kbit_training(model)
    target = ALL_LINEAR if hp.targetModules == ALL_LINEAR else list(hp.targetModules)
    lora = LoraConfig(
        r=hp.loraR,
        lora_alpha=hp.loraAlpha,
        lora_dropout=hp.loraDropout,
        target_modules=target,
        bias="none",
        task_type="CAUSAL_LM",
    )
    try:
        model = get_peft_model(model, lora)
    except ValueError as error:
        raise ConfigError(
            f"targetModules matches no layer of the base model: {error}", code="target_modules_not_found"
        )
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    if trainable == 0:
        raise ConfigError("targetModules left nothing to train", code="target_modules_not_found")
    model.config.use_cache = False
    return model, trainable


def forward_loss(model, batch: dict, device: str):
    """One forward pass. Module-level so a test can replace it."""
    import torch

    batch = {name: tensor.to(device) for name, tensor in batch.items()}
    if device == "cuda":
        context = torch.autocast("cuda", dtype=torch.bfloat16)
    else:
        context = contextlib.nullcontext()
    with context:
        return model(**batch).loss


# ---------------------------------------------------------------------------
# Checkpoints (local only; see README "Resuming")
# ---------------------------------------------------------------------------


def _checkpoint_fingerprint(cfg: TrainerConfig, total_steps: int, train_rows: int) -> dict:
    hp = cfg.hyperparams.to_json()
    return {
        "version": CHECKPOINT_VERSION,
        "baseModel": cfg.base_model,
        "method": cfg.method,
        "hyperparams": hp,
        "totalSteps": total_steps,
        "trainRows": train_rows,
    }


def save_checkpoint(directory: str, model, optimizer, scheduler, state: dict) -> None:
    """Write the adapter and the optimiser state, replacing the previous
    checkpoint only once the new one is complete."""
    import torch

    staging = directory + ".tmp"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    model.save_pretrained(staging, safe_serialization=True, save_embedding_layers=False)
    torch.save(
        {"optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(), "state": json.dumps(state)},
        os.path.join(staging, CHECKPOINT_STATE_FILE),
    )
    shutil.rmtree(directory, ignore_errors=True)
    os.replace(staging, directory)


def load_checkpoint(directory: str, model, optimizer, scheduler, fingerprint: dict) -> dict:
    import torch
    from peft import set_peft_model_state_dict
    from safetensors.torch import load_file

    state_path = os.path.join(directory, CHECKPOINT_STATE_FILE)
    weights_path = os.path.join(directory, "adapter_model.safetensors")
    if not os.path.isfile(state_path) or not os.path.isfile(weights_path):
        raise ConfigError("--resume-from does not hold a trainer checkpoint", code="resume_not_found")
    saved = torch.load(state_path, map_location="cpu", weights_only=True)
    state = json.loads(saved["state"])
    if state.get("fingerprint") != fingerprint:
        raise ConfigError(
            "--resume-from was written by a run with a different model, dataset or hyperparameters",
            code="resume_mismatch",
        )
    set_peft_model_state_dict(model, load_file(weights_path))
    optimizer.load_state_dict(saved["optimizer"])
    scheduler.load_state_dict(saved["scheduler"])
    return state


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------


def evaluate(model, examples: list, batch_size: int, pad_token_id: int, device: str) -> float | None:
    """Mean loss per supervised token over the held-out rows."""
    import torch

    if not examples:
        return None
    model.eval()
    total_loss = 0.0
    total_labels = 0
    with torch.no_grad():
        for start in range(0, len(examples), batch_size):
            batch = collate(examples[start : start + batch_size], pad_token_id)
            labels = int((batch["labels"] != -100).sum())
            total_loss += float(forward_loss(model, batch, device)) * labels
            total_labels += labels
    model.train()
    if total_labels == 0:
        return None
    value = total_loss / total_labels
    return value if math.isfinite(value) else None


def train(
    cfg: TrainerConfig,
    model,
    train_examples: list,
    eval_examples: list,
    pad_token_id: int,
    device: str,
    emitter: EventEmitter,
    deadline: float | None,
    checkpoint_dir: str,
    resume_from: str | None,
) -> dict:
    """Run the optimisation. Returns the facts that go into metrics.json."""
    import torch
    from transformers import get_linear_schedule_with_warmup

    hp = cfg.hyperparams
    batches_per_epoch = math.ceil(len(train_examples) / hp.batchSize)
    steps_per_epoch = math.ceil(batches_per_epoch / hp.gradientAccumulationSteps)
    total_steps = steps_per_epoch * hp.epochs
    if hp.maxSteps is not None:
        total_steps = min(total_steps, hp.maxSteps)
    warmup_steps = int(total_steps * hp.warmupRatio)

    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=hp.learningRate, weight_decay=0.0)
    scheduler = get_linear_schedule_with_warmup(optimizer, warmup_steps, total_steps)

    step = 0
    start_epoch = 0
    train_tokens = 0
    train_curve: list = []
    eval_curve: list = []
    fingerprint = _checkpoint_fingerprint(cfg, total_steps, len(train_examples))
    if resume_from:
        state = load_checkpoint(resume_from, model, optimizer, scheduler, fingerprint)
        step = state["step"]
        start_epoch = state["epoch"]
        train_tokens = state["trainTokens"]
        train_curve = state["trainLoss"]
        eval_curve = state["evalLoss"]

    model.train()
    optimizer.zero_grad(set_to_none=True)
    started = time.monotonic()
    resumed_at_step = step
    tokens_this_run = 0
    stop_reason = "finished"
    last_eval_step = eval_curve[-1]["step"] if eval_curve else -1
    done = step >= total_steps

    def run_eval() -> None:
        nonlocal last_eval_step
        if not eval_examples or last_eval_step == step:
            return
        value = evaluate(model, eval_examples, hp.batchSize, pad_token_id, device)
        last_eval_step = step
        if value is not None:
            eval_curve.append({"step": step, "loss": round(value, 6)})
            emitter.emit("eval", step=step, evalLoss=round(value, 6))

    for epoch in range(start_epoch, hp.epochs):
        if done:
            break
        # A fixed order per epoch, so a resumed run sees what the first would.
        order = list(range(len(train_examples)))
        random.Random(hp.seed + epoch).shuffle(order)
        batches = [order[i : i + hp.batchSize] for i in range(0, len(order), hp.batchSize)]
        group_losses: list = []
        for index, rows in enumerate(batches):
            batch = collate([train_examples[row] for row in rows], pad_token_id)
            tokens = int(batch["attention_mask"].sum())
            loss = forward_loss(model, batch, device)
            value = float(loss.detach())
            if not math.isfinite(value):
                raise DivergedError(
                    f"The training loss became {value} at step {step + 1}. "
                    "A lower learning rate usually fixes this.",
                    step=step + 1,
                )
            (loss / hp.gradientAccumulationSteps).backward()
            group_losses.append(value)
            train_tokens += tokens
            tokens_this_run += tokens

            last_in_epoch = index + 1 == len(batches)
            if (index + 1) % hp.gradientAccumulationSteps != 0 and not last_in_epoch:
                continue

            torch.nn.utils.clip_grad_norm_(parameters, GRADIENT_CLIP_NORM)
            learning_rate = scheduler.get_last_lr()[0]
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            step_loss = sum(group_losses) / len(group_losses)
            group_losses = []
            train_curve.append({"step": step, "loss": round(step_loss, 6), "lr": learning_rate})

            elapsed = time.monotonic() - started
            steps_this_run = step - resumed_at_step
            done = step >= total_steps
            if not done and deadline is not None and time.monotonic() >= deadline:
                # Reached only after at least one step: a run with nothing
                # trained has no adapter worth handing over, so it keeps
                # going until the host's own timeout stops it (exit 30).
                done = True
                stop_reason = "max_runtime"
            emitter.step(
                force=done,
                step=step,
                totalSteps=total_steps,
                epoch=round(epoch + (index + 1) / len(batches), 4),
                loss=round(step_loss, 6),
                lr=learning_rate,
                tokensPerSecond=round(tokens_this_run / elapsed, 1) if elapsed > 0 else None,
                etaSeconds=round((total_steps - step) * elapsed / steps_this_run),
            )
            if done:
                break

        run_eval()
        if not done:
            # A whole epoch is behind us and more are to come.
            save_checkpoint(
                checkpoint_dir,
                model,
                optimizer,
                scheduler,
                {
                    "fingerprint": fingerprint,
                    "step": step,
                    "epoch": epoch + 1,
                    "trainTokens": train_tokens,
                    "trainLoss": train_curve,
                    "evalLoss": eval_curve,
                },
            )

    if stop_reason == "finished" and hp.maxSteps is not None and step < steps_per_epoch * hp.epochs:
        stop_reason = "max_steps"
    run_eval()
    train_seconds = time.monotonic() - started
    window = train_curve[-FINAL_LOSS_WINDOW:]
    return {
        "steps": step,
        "totalSteps": total_steps,
        "warmupSteps": warmup_steps,
        "epochs": round(step / steps_per_epoch, 4) if steps_per_epoch else 0,
        "stopReason": stop_reason,
        "trainLoss": train_curve,
        "evalLoss": eval_curve,
        "finalTrainLoss": round(sum(p["loss"] for p in window) / len(window), 6) if window else None,
        "finalEvalLoss": eval_curve[-1]["loss"] if eval_curve else None,
        "trainTokens": train_tokens,
        "trainTokensPerSecond": round(tokens_this_run / train_seconds, 1) if train_seconds > 0 else None,
        "trainSeconds": round(train_seconds, 3),
    }


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


def save_adapter(model, adapter_dir: str, cfg: TrainerConfig, stats, trainable: int) -> dict:
    """Write the adapter directory and check it is the shape vLLM loads."""
    os.makedirs(adapter_dir, exist_ok=True)
    # save_embedding_layers=False: the default ("auto") asks the Hub whether
    # the vocabulary changed. It never does here, and the run must not
    # depend on one more network call after the GPU time is spent.
    model.save_pretrained(adapter_dir, safe_serialization=True, save_embedding_layers=False)
    # peft writes a model-card README beside the weights; it is not ours.
    with contextlib.suppress(FileNotFoundError):
        os.remove(os.path.join(adapter_dir, "README.md"))

    with open(os.path.join(adapter_dir, "adapter_config.json"), "r", encoding="utf-8") as handle:
        adapter_config = json.load(handle)
    if adapter_config.get("modules_to_save"):
        raise TrainerError("The adapter carries modules_to_save and would not load for serving")
    if not os.path.isfile(os.path.join(adapter_dir, "adapter_model.safetensors")):
        raise TrainerError("The adapter weights were not written as safetensors")
    target_modules = sorted(adapter_config.get("target_modules") or [])

    hp = cfg.hyperparams
    manifest = {
        "schema": METRICS_SCHEMA_VERSION,
        "jobId": cfg.job_id,
        "baseModel": cfg.base_model,
        "method": cfg.method,
        "format": stats.format,
        "r": hp.loraR,
        "alpha": hp.loraAlpha,
        "dropout": hp.loraDropout,
        "targetModules": target_modules,
        "maxSeqLength": hp.maxSeqLength,
        "trainableParameters": trainable,
        # Stated so the serving side need not infer them: the base model's
        # tokenizer and embeddings are used unchanged.
        "tokensAdded": False,
        "embeddingsResized": False,
        "systemRoleFolded": stats.systemFolded,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "libraryVersions": library_versions(),
    }
    with open(os.path.join(adapter_dir, "wheelsai_manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, allow_nan=False)
    return {"targetModules": target_modules}


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def run(cfg: TrainerConfig, args, emitter: EventEmitter, process_started: float) -> None:
    import torch

    device = resolve_device(args.device)
    if cfg.method == "qlora" and device != "cuda":
        raise ConfigError(
            "METHOD=qlora needs a CUDA GPU: 4-bit loading (bitsandbytes) does not run on CPU. "
            "Use METHOD=lora, which loads the base model unquantised.",
            code="qlora_requires_cuda",
        )
    hp = cfg.hyperparams
    random.seed(hp.seed)
    torch.manual_seed(hp.seed)
    gpu = gpu_facts(device)
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    work_dir = args.work_dir
    data_dir = os.path.join(work_dir, "data")
    out_dir = os.path.join(work_dir, "out")
    adapter_dir = os.path.join(out_dir, "adapter")
    checkpoint_dir = os.path.join(work_dir, "checkpoints", "latest")
    for directory in (data_dir, out_dir, os.path.dirname(checkpoint_dir)):
        os.makedirs(directory, exist_ok=True)
    shutil.rmtree(adapter_dir, ignore_errors=True)

    emitter.emit(
        "started",
        gpu=gpu["name"],
        vramGb=gpu["vramGb"],
        device=device,
        method=cfg.method,
        baseModel=cfg.base_model,
        trainerVersion=TRAINER_VERSION,
    )
    timings: dict = {}

    emitter.phase("download_dataset")
    clock = time.monotonic()
    dataset_path = os.path.join(data_dir, f"data.{cfg.dataset_file_type}")
    downloaded = download_dataset(cfg.dataset_url, dataset_path, cfg.dataset_sha256)
    timings["download"] = round(time.monotonic() - clock, 3)

    emitter.phase("load_model")
    clock = time.monotonic()
    tokenizer, model = load_tokenizer_and_model(cfg, device)
    pad_token_id, pad_source = resolve_pad_token_id(tokenizer)
    model, trainable = apply_lora(model, cfg)
    timings["load"] = round(time.monotonic() - clock, 3)

    emitter.phase("tokenize")
    clock = time.monotonic()
    examples, stats = build_examples(
        dataset_path, cfg.dataset_file_type, cfg.dataset_format, tokenizer, hp.maxSeqLength
    )
    train_examples, eval_examples = split_examples(examples, hp.evalSplit, hp.seed)
    stats.eval = len(eval_examples)
    timings["tokenize"] = round(time.monotonic() - clock, 3)

    emitter.phase("train")
    deadline = None
    if cfg.max_runtime_seconds is not None:
        deadline = process_started + cfg.max_runtime_seconds - runtime_reserve_seconds(cfg.max_runtime_seconds)
    result = train(
        cfg,
        model,
        train_examples,
        eval_examples,
        pad_token_id,
        device,
        emitter,
        deadline,
        checkpoint_dir,
        args.resume_from,
    )
    timings["train"] = result["trainSeconds"]

    emitter.phase("upload")
    saved = save_adapter(model, adapter_dir, cfg, stats, trainable)
    archive_path = os.path.join(out_dir, ADAPTER_ARCHIVE_NAME)
    packed = pack_adapter(adapter_dir, archive_path)
    clock = time.monotonic()
    put_file(cfg.adapter_upload_url, archive_path, ADAPTER_CONTENT_TYPE, what="adapter")
    timings["upload"] = round(time.monotonic() - clock, 3)

    peak_vram = None
    if device == "cuda":
        peak_vram = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    metrics = {
        "schema": METRICS_SCHEMA_VERSION,
        "jobId": cfg.job_id,
        "baseModel": cfg.base_model,
        "method": cfg.method,
        "hyperparams": hp.to_json(),
        "dataset": {
            "format": stats.format,
            "fileType": cfg.dataset_file_type,
            "bytes": downloaded["bytes"],
            "sha256": downloaded["sha256"],
        },
        "rows": stats.to_json(),
        "steps": result["steps"],
        "totalSteps": result["totalSteps"],
        "warmupSteps": result["warmupSteps"],
        "epochs": result["epochs"],
        "stopReason": result["stopReason"],
        "trainLoss": thin(result["trainLoss"]),
        "evalLoss": thin(result["evalLoss"]),
        "finalTrainLoss": result["finalTrainLoss"],
        "finalEvalLoss": result["finalEvalLoss"],
        "trainTokens": result["trainTokens"],
        "trainTokensPerSecond": result["trainTokensPerSecond"],
        "timings": timings,
        "gpu": {"name": gpu["name"], "vramGb": gpu["vramGb"], "peakVramGb": peak_vram},
        "adapter": {
            "bytes": packed["bytes"],
            "sha256": packed["sha256"],
            "files": packed["files"],
            "r": hp.loraR,
            "alpha": hp.loraAlpha,
            "targetModules": saved["targetModules"],
            "trainableParameters": trainable,
        },
        "tokenizer": {"padTokenFrom": pad_source, "systemRoleFolded": stats.systemFolded},
        "libraryVersions": library_versions(),
    }
    metrics_path = os.path.join(out_dir, "metrics.json")
    with open(metrics_path, "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, allow_nan=False)
    put_file(cfg.metrics_upload_url, metrics_path, METRICS_CONTENT_TYPE, what="metrics")

    # Both objects are stored before either event is sent: `uploaded` means
    # the artifacts can be fetched, not that a transfer was attempted.
    emitter.emit("uploaded", adapterBytes=packed["bytes"], adapterSha256=packed["sha256"])
    emitter.emit(
        "completed",
        finalTrainLoss=result["finalTrainLoss"],
        finalEvalLoss=result["finalEvalLoss"],
        trainSeconds=result["trainSeconds"],
        steps=result["steps"],
        totalSteps=result["totalSteps"],
        stopReason=result["stopReason"],
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse_args(argv: list | None):
    parser = argparse.ArgumentParser(
        prog="train.py",
        description="WheelsAI LoRA / QLoRA trainer. Inputs are environment variables; see README.md.",
    )
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--work-dir", default=DEFAULT_WORK_DIR)
    parser.add_argument("--resume-from", default=None, metavar="DIR")
    parser.add_argument("--version", action="version", version=TRAINER_VERSION)
    return parser.parse_args(argv)


def _early_sender(env: Mapping[str, str]) -> CallbackSender | None:
    """A callback sender for a run whose configuration was refused, so the
    API hears about exit 10 while it happens. Built from the raw variables
    because the parsed configuration does not exist."""
    url = (env.get("CALLBACK_URL") or "").strip()
    secret = (env.get("CALLBACK_SECRET") or "").strip()
    job_id = (env.get("JOB_ID") or "").strip()
    if not url.startswith(("http://", "https://")) or not secret or not job_id:
        return None
    return CallbackSender(url, secret, job_id)


def _install_signal_handlers(state: dict):
    """SIGTERM is how a host stops a job; turn it into exit 30 with a
    `failed` event instead of a silent kill. Only the first signal raises,
    so the clean-up it starts is not itself interrupted."""
    if threading.current_thread() is not threading.main_thread():
        return lambda: None

    def handler(signum, _frame):
        if state.get("interrupted"):
            return
        state["interrupted"] = True
        raise Interrupted(signal.Signals(signum).name)

    previous = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.signal(signum, handler)

    def restore():
        for signum, old in previous.items():
            signal.signal(signum, old)

    return restore


def _run_to_exit_code(args, env: Mapping[str, str], emitter: EventEmitter, holder: dict) -> int:
    process_started = time.monotonic()
    secrets: tuple = ()
    try:
        try:
            cfg = load_config(env)
        except ConfigError:
            holder["sender"] = _early_sender(env)
            if holder["sender"] is not None:
                emitter.set_sink(holder["sender"].send)
            raise
        secrets = cfg.secrets
        emitter.set_secrets(secrets)
        if cfg.callback_url:
            holder["sender"] = CallbackSender(cfg.callback_url, cfg.callback_secret, cfg.job_id)
            emitter.set_sink(holder["sender"].send)
        run(cfg, args, emitter, process_started)
        return EXIT_OK
    except TrainerError as error:
        emitter.failed(error.exit_code, error.code, error.message, **error.details)
        return error.exit_code
    except Interrupted as stop:
        emitter.failed(EXIT_INTERRUPTED, "interrupted", f"Stopped by {stop.signal_name}", signal=stop.signal_name)
        return EXIT_INTERRUPTED
    except Exception as error:  # noqa: BLE001 - the last line of defence
        memory_code = is_out_of_memory(error)
        if memory_code:
            emitter.failed(
                EXIT_OUT_OF_MEMORY,
                memory_code,
                "The run ran out of memory. A smaller batchSize or maxSeqLength, or a larger GPU, is needed.",
            )
            return EXIT_OUT_OF_MEMORY
        sys.stderr.write(redact(traceback.format_exc(), secrets))
        sys.stderr.flush()
        emitter.failed(EXIT_UNEXPECTED, "unexpected", f"{type(error).__name__}: {error}")
        return EXIT_UNEXPECTED


def main(argv: list | None = None, env: Mapping[str, str] | None = None) -> int:
    """Run once and return the exit code. Never raises."""
    args = parse_args(argv)
    env = os.environ if env is None else env
    emitter = EventEmitter()
    holder: dict = {"sender": None}
    signal_state: dict = {}
    restore = _install_signal_handlers(signal_state)
    try:
        try:
            code = _run_to_exit_code(args, env, emitter, holder)
        except Interrupted as stop:
            # A stop that arrived while another failure was being reported.
            emitter.failed(EXIT_INTERRUPTED, "interrupted", f"Stopped by {stop.signal_name}", signal=stop.signal_name)
            code = EXIT_INTERRUPTED
        if holder["sender"] is not None:
            # A stopped job has seconds before SIGKILL; do not spend them
            # all waiting for an API that may be the reason for the stop.
            holder["sender"].close(8.0 if code == EXIT_INTERRUPTED else 45.0)
        return code
    finally:
        restore()
