"""Whole runs on CPU: a two-layer random Llama, a tokenizer trained on the
fixture, and one loopback server for the three URLs and the callbacks.

Each test runs the real entry point (`main`) with a real environment, so
what is asserted is what a job would do: the events it prints, the callbacks
it signs, the two objects it uploads and the code it exits with.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import time

import pytest

from conftest import (
    CALLBACK_SECRET,
    FIXTURE_JSONL,
    TRAIN_SCRIPT,
    base_env,
    fixture_rows,
    jsonl_bytes,
    run_trainer,
)
from wheelsai_trainer import runner
from wheelsai_trainer.callbacks import SIGNATURE_HEADER
from wheelsai_trainer.events import parse_event_line


def fixture_bytes() -> bytes:
    with open(FIXTURE_JSONL, "rb") as handle:
        return handle.read()


def types(events: list) -> list:
    return [event["type"] for event in events]


def last(events: list, event_type: str) -> dict:
    return [event for event in events if event["type"] == event_type][-1]


def extract_adapter(storage, directory) -> str:
    os.makedirs(directory, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(storage.uploads["/adapter"]["body"]), mode="r:gz") as tar:
        tar.extractall(directory)
    return str(directory)


def assert_no_secret_in(text: str) -> None:
    for secret in (CALLBACK_SECRET, "datasetsignature123", "adaptersignature456", "metricssignature789"):
        assert secret not in text


# --- success --------------------------------------------------------------


def test_lora_run_trains_uploads_and_reports(storage, tiny_model_dir, tmp_path, capsys):
    body = fixture_bytes()
    storage.objects["/dataset"] = body
    env = base_env(storage, tiny_model_dir, DATASET_SHA256=hashlib.sha256(body).hexdigest())
    code, events, out = run_trainer(env, tmp_path / "work", capsys)
    assert code == 0

    # Events: ordered, numbered from 1 without gaps, phases in contract order.
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert types(events)[0] == "started" and types(events)[-2:] == ["uploaded", "completed"]
    assert [e["phase"] for e in events if e["type"] == "phase"] == [
        "download_dataset",
        "load_model",
        "tokenize",
        "train",
        "upload",
    ]
    started = events[0]
    assert started["gpu"] is None and started["vramGb"] is None
    assert started["device"] == "cpu" and started["method"] == "lora"
    steps = [e for e in events if e["type"] == "step"]
    # 40 rows / batch 4 = 10 steps an epoch, 2 epochs. The throttle lets the
    # first and the forced last through on a run this short.
    assert steps[0]["step"] == 1 and steps[-1]["step"] == 20
    assert steps[-1]["totalSteps"] == 20 and steps[-1]["epoch"] == 2.0 and steps[-1]["etaSeconds"] == 0
    assert all(isinstance(e["loss"], float) and e["loss"] > 0 and e["lr"] >= 0 for e in steps)
    completed = events[-1]
    assert completed["steps"] == 20 and completed["stopReason"] == "finished"
    assert completed["finalEvalLoss"] is None and completed["finalTrainLoss"] > 0

    # Callbacks: every printed event arrived once, in order, correctly signed.
    received = storage.callback_events()
    assert [e["seq"] for e in received] == [e["seq"] for e in events]
    assert all(e["jobId"] == "job_test_1" for e in received)
    for entry, event in zip(storage.callbacks, events):
        assert {k: v for k, v in json.loads(entry["raw"]).items() if k != "jobId"} == event
        header = dict(part.split("=", 1) for part in entry["headers"][SIGNATURE_HEADER].split(","))
        expected = hmac.new(
            CALLBACK_SECRET.encode(), header["t"].encode() + b"." + entry["raw"], hashlib.sha256
        ).hexdigest()
        assert header["v1"] == expected
        assert abs(int(header["t"]) - time.time()) < 300

    # Adapter archive: the two files vLLM loads plus the manifest, nothing else.
    upload = storage.uploads["/adapter"]
    assert upload["headers"]["Content-Type"] == "application/gzip"
    archive = upload["body"]
    uploaded = last(events, "uploaded")
    assert uploaded["adapterBytes"] == len(archive)
    assert uploaded["adapterSha256"] == hashlib.sha256(archive).hexdigest()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        assert tar.getnames() == ["adapter_config.json", "adapter_model.safetensors", "wheelsai_manifest.json"]
        adapter_config = json.load(tar.extractfile("adapter_config.json"))
        manifest = json.load(tar.extractfile("wheelsai_manifest.json"))
    assert adapter_config["peft_type"] == "LORA" and adapter_config["task_type"] == "CAUSAL_LM"
    assert adapter_config["r"] == 8 and adapter_config["lora_alpha"] == 16
    assert adapter_config["modules_to_save"] is None
    assert adapter_config["bias"] == "none" and adapter_config["use_dora"] is False
    # "all-linear" resolved to the attention and MLP projections, never the head.
    assert sorted(adapter_config["target_modules"]) == [
        "down_proj", "gate_proj", "k_proj", "o_proj", "q_proj", "up_proj", "v_proj",
    ]  # fmt: skip
    assert manifest["tokensAdded"] is False and manifest["embeddingsResized"] is False
    assert manifest["jobId"] == "job_test_1" and manifest["format"] == "alpaca"

    # metrics.json
    assert storage.uploads["/metrics"]["headers"]["Content-Type"] == "application/json"
    metrics = json.loads(storage.uploads["/metrics"]["body"])
    assert set(metrics) == {
        "schema", "jobId", "baseModel", "method", "hyperparams", "dataset", "rows", "steps", "totalSteps",
        "warmupSteps", "epochs", "stopReason", "trainLoss", "evalLoss", "finalTrainLoss", "finalEvalLoss",
        "trainTokens", "trainTokensPerSecond", "timings", "gpu", "adapter", "tokenizer", "libraryVersions",
    }  # fmt: skip
    assert metrics["schema"] == 1 and metrics["jobId"] == "job_test_1" and metrics["method"] == "lora"
    assert metrics["hyperparams"]["batchSize"] == 4 and metrics["hyperparams"]["targetModules"] == "all-linear"
    assert metrics["dataset"] == {
        "format": "alpaca",
        "fileType": "jsonl",
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
    }
    assert metrics["rows"]["total"] == 40 and metrics["rows"]["used"] == 40
    assert metrics["rows"]["truncated"] == 0 and metrics["rows"]["eval"] == 0 and metrics["rows"]["skipped"] == 0
    assert metrics["steps"] == 20 and metrics["epochs"] == 2.0
    assert [point["step"] for point in metrics["trainLoss"]] == list(range(1, 21))
    assert all(set(point) == {"step", "loss", "lr"} for point in metrics["trainLoss"])
    assert metrics["evalLoss"] == [] and metrics["finalEvalLoss"] is None
    assert metrics["finalTrainLoss"] == completed["finalTrainLoss"]
    # Two epochs over the same rows: every token is seen twice.
    assert metrics["trainTokens"] == 2 * metrics["rows"]["tokens"]
    assert metrics["trainTokensPerSecond"] > 0
    assert set(metrics["timings"]) == {"download", "load", "tokenize", "train", "upload"}
    assert metrics["gpu"] == {"name": None, "vramGb": None, "peakVramGb": None}
    assert metrics["adapter"]["bytes"] == len(archive) and metrics["adapter"]["sha256"] == uploaded["adapterSha256"]
    assert metrics["adapter"]["r"] == 8 and metrics["adapter"]["alpha"] == 16
    assert metrics["adapter"]["targetModules"] == sorted(adapter_config["target_modules"])
    assert metrics["tokenizer"] == {"padTokenFrom": "eos", "systemRoleFolded": False}
    assert metrics["libraryVersions"]["peft"] == "0.13.2" and metrics["libraryVersions"]["torch"].startswith("2.4.1")

    # No credential in anything the run printed, posted or stored.
    assert_no_secret_in(out)
    assert_no_secret_in(storage.uploads["/metrics"]["body"].decode())
    assert_no_secret_in(b"".join(entry["raw"] for entry in storage.callbacks).decode())


def test_adapter_reloads_onto_the_base_model_and_generates(storage, tiny_model_dir, tmp_path, capsys):
    import torch
    from peft import PeftModel
    from safetensors.torch import load_file
    from transformers import AutoModelForCausalLM, AutoTokenizer

    storage.objects["/dataset"] = fixture_bytes()
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 0
    adapter_dir = extract_adapter(storage, tmp_path / "adapter")

    # Only LoRA matrices: no embedding, head or full-layer weights.
    weights = load_file(os.path.join(adapter_dir, "adapter_model.safetensors"))
    assert weights and all(".lora_A." in name or ".lora_B." in name for name in weights)
    assert not any("embed" in name or "lm_head" in name for name in weights)
    # lora_B starts at zero, so a non-zero B is proof the optimiser moved it.
    assert any(float(t.abs().sum()) > 0 for name, t in weights.items() if ".lora_B." in name)

    tokenizer = AutoTokenizer.from_pretrained(tiny_model_dir)
    base = AutoModelForCausalLM.from_pretrained(tiny_model_dir)
    # The adapter was trained against this vocabulary size and no other.
    assert base.get_input_embeddings().weight.shape[0] == len(tokenizer)
    prompt = tokenizer.apply_chat_template(
        [{"role": "user", "content": "Add 2 and 3, in WheelsAI report style."}],
        tokenize=False,
        add_generation_prompt=True,
    )
    encoded = tokenizer(prompt, return_tensors="pt", add_special_tokens=False)
    inputs = {"input_ids": encoded["input_ids"], "attention_mask": encoded["attention_mask"]}
    with torch.no_grad():
        plain = base(**inputs).logits
    tuned = PeftModel.from_pretrained(base, adapter_dir)
    tuned.eval()
    with torch.no_grad():
        changed = tuned(**inputs).logits
        generated = tuned.generate(
            **inputs, max_new_tokens=12, do_sample=False, pad_token_id=tokenizer.eos_token_id
        )
    assert not torch.allclose(plain, changed), "the adapter must change the model's output"
    new_tokens = generated[0, inputs["input_ids"].shape[1] :]
    assert 1 <= new_tokens.shape[0] <= 12
    assert isinstance(tokenizer.decode(new_tokens), str)

    # The training loss the run reported is the loss this adapter gives.
    assert last(events, "completed")["finalTrainLoss"] < 7.0


def rows_as(kind: str) -> tuple:
    """The fixture in another row format and file type: (bytes, env changes, format)."""
    rows = fixture_rows()
    prompts = [f"{r['instruction']}\n\n{r['input']}" if r.get("input") else r["instruction"] for r in rows]
    if kind == "sharegpt-jsonl":
        converted = [
            {
                "conversations": [
                    {"from": "system", "value": "You are a careful assistant."},
                    {"from": "human", "value": prompt},
                    {"from": "gpt", "value": row["output"]},
                ]
            }
            for prompt, row in zip(prompts, rows)
        ]
        return jsonl_bytes(converted), {}, "sharegpt"
    if kind == "completion-csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["prompt", "completion"])
        writer.writerows([prompt, row["output"]] for prompt, row in zip(prompts, rows))
        return buffer.getvalue().encode(), {"DATASET_FILE_TYPE": "csv"}, "completion"
    if kind == "text-jsonl":
        return jsonl_bytes([{"text": f"{p} {r['output']}"} for p, r in zip(prompts, rows)]), {}, "text"
    if kind == "text-csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["text"])
        writer.writerows([f"{p} {r['output']}"] for p, r in zip(prompts, rows))
        return buffer.getvalue().encode(), {"DATASET_FILE_TYPE": "csv"}, "text"
    if kind == "alpaca-parquet":
        import pyarrow as pa
        import pyarrow.parquet as pq

        buffer = io.BytesIO()
        pq.write_table(pa.Table.from_pylist([{**r, "input": r.get("input")} for r in rows]), buffer)
        return buffer.getvalue(), {"DATASET_FILE_TYPE": "parquet"}, "alpaca"
    raise AssertionError(kind)


@pytest.mark.parametrize("kind", ["sharegpt-jsonl", "completion-csv", "text-jsonl", "text-csv", "alpaca-parquet"])
def test_each_format_and_file_type_trains_to_a_loadable_adapter(kind, storage, tiny_model_dir, tmp_path, capsys):
    body, changes, expected_format = rows_as(kind)
    storage.objects["/dataset"] = body
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir, **changes), tmp_path / "work", capsys)
    assert code == 0, events[-1]
    metrics = json.loads(storage.uploads["/metrics"]["body"])
    assert metrics["dataset"]["format"] == expected_format
    assert metrics["rows"]["used"] == 40 and metrics["steps"] == 20
    assert all(point["loss"] > 0 for point in metrics["trainLoss"])
    with tarfile.open(fileobj=io.BytesIO(storage.uploads["/adapter"]["body"]), mode="r:gz") as tar:
        assert {"adapter_config.json", "adapter_model.safetensors"} <= set(tar.getnames())


def test_a_template_without_a_system_role_still_trains(storage, strict_model_dir, tmp_path, capsys):
    body, _, _ = rows_as("sharegpt-jsonl")
    storage.objects["/dataset"] = body
    code, events, _ = run_trainer(base_env(storage, strict_model_dir), tmp_path / "work", capsys)
    assert code == 0, events[-1]
    metrics = json.loads(storage.uploads["/metrics"]["body"])
    assert metrics["tokenizer"]["systemRoleFolded"] is True
    assert metrics["rows"]["used"] == 40 and metrics["rows"]["skipped"] == 0
    with tarfile.open(fileobj=io.BytesIO(storage.uploads["/adapter"]["body"]), mode="r:gz") as tar:
        assert json.load(tar.extractfile("wheelsai_manifest.json"))["systemRoleFolded"] is True


def test_the_base_model_and_tokenizer_are_left_as_they_were(storage, tiny_model_dir, tmp_path, capsys):
    """No pad token in the tokenizer: the run must not add one, must not
    resize the embeddings and must not write tokenizer files."""
    before = {name: os.path.getmtime(os.path.join(tiny_model_dir, name)) for name in os.listdir(tiny_model_dir)}
    storage.objects["/dataset"] = fixture_bytes()
    work = tmp_path / "work"
    code, _, _ = run_trainer(base_env(storage, tiny_model_dir), work, capsys)
    assert code == 0
    assert before == {
        name: os.path.getmtime(os.path.join(tiny_model_dir, name)) for name in os.listdir(tiny_model_dir)
    }
    assert sorted(os.listdir(work / "out" / "adapter")) == [
        "adapter_config.json",
        "adapter_model.safetensors",
        "wheelsai_manifest.json",
    ]


def test_explicit_target_modules_eval_split_accumulation_and_max_steps(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(
        storage,
        tiny_model_dir,
        hyperparams={
            "targetModules": ["q_proj", "v_proj"],
            "evalSplit": 0.1,
            "gradientAccumulationSteps": 3,
            "epochs": 3,
            "maxSteps": 5,
            "warmupRatio": 0.2,
        },
    )
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 0, events[-1]
    metrics = json.loads(storage.uploads["/metrics"]["body"])
    assert metrics["adapter"]["targetModules"] == ["q_proj", "v_proj"]
    # 36 training rows / batch 4 = 9 batches, 3 to a step = 3 steps an epoch.
    assert metrics["rows"]["eval"] == 4
    assert metrics["totalSteps"] == 5 and metrics["steps"] == 5 and metrics["stopReason"] == "max_steps"
    assert metrics["warmupSteps"] == 1
    # Warm-up: the first step runs at lr 0, the second at the full rate.
    assert metrics["trainLoss"][0]["lr"] == 0 and metrics["trainLoss"][1]["lr"] == pytest.approx(1e-3)
    evals = [e for e in events if e["type"] == "eval"]
    # One evaluation at the end of the first whole epoch, one at the stop.
    assert [e["step"] for e in evals] == [3, 5]
    assert metrics["evalLoss"] == [{"step": e["step"], "loss": e["evalLoss"]} for e in evals]
    assert metrics["finalEvalLoss"] == evals[-1]["evalLoss"] == events[-1]["finalEvalLoss"]


def test_a_dead_callback_endpoint_does_not_fail_the_run(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    storage.status["/callback"] = 500
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 0
    assert types(events)[-1] == "completed"
    assert "/adapter" in storage.uploads and "/metrics" in storage.uploads
    # Each event was tried three times before the run moved on.
    assert storage.count("POST", "/callback") == 3 * len(events)


def test_a_run_without_callbacks_still_prints_every_event(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(storage, tiny_model_dir, CALLBACK_URL=None, CALLBACK_SECRET=None)
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 0 and types(events)[-1] == "completed"
    assert storage.callbacks == []


def test_reaching_the_run_limit_stops_early_and_still_hands_over_the_adapter(
    storage, tiny_model_dir, tmp_path, capsys, monkeypatch
):
    storage.objects["/dataset"] = fixture_bytes()
    # Reserve the whole limit, so the deadline has passed by the first step.
    monkeypatch.setattr(runner, "runtime_reserve_seconds", lambda limit: float(limit))
    env = base_env(storage, tiny_model_dir, MAX_RUNTIME_SECONDS="600")
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 0
    completed = events[-1]
    assert completed["type"] == "completed" and completed["stopReason"] == "max_runtime"
    assert completed["steps"] == 1 and completed["totalSteps"] == 20
    assert json.loads(storage.uploads["/metrics"]["body"])["stopReason"] == "max_runtime"
    assert "/adapter" in storage.uploads


def test_runtime_reserve_is_bounded():
    assert runner.runtime_reserve_seconds(60) == 30
    assert runner.runtime_reserve_seconds(1200) == 120
    assert runner.runtime_reserve_seconds(21600) == 300


def test_resume_continues_from_the_last_whole_epoch(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    # No dropout: its random stream is not part of a checkpoint, and with it
    # off the replayed epoch can be compared number for number.
    env = base_env(storage, tiny_model_dir, hyperparams={"loraDropout": 0})
    first_work = tmp_path / "first"
    code, _, _ = run_trainer(env, first_work, capsys)
    assert code == 0
    checkpoint = first_work / "checkpoints" / "latest"
    assert sorted(os.listdir(checkpoint)) == [
        "README.md", "adapter_config.json", "adapter_model.safetensors", "trainer_state.pt",
    ]  # fmt: skip
    first = json.loads(storage.uploads["/metrics"]["body"])

    code, events, _ = run_trainer(env, tmp_path / "second", capsys, ["--resume-from", str(checkpoint)])
    assert code == 0, events[-1]
    steps = [e["step"] for e in events if e["type"] == "step"]
    assert steps[0] == 11 and steps[-1] == 20
    second = json.loads(storage.uploads["/metrics"]["body"])
    assert [p["step"] for p in second["trainLoss"]] == list(range(1, 21))
    # Epoch one is the first run's; epoch two replays the same batches from
    # the same weights and optimiser state, so it lands on the same losses.
    assert second["trainLoss"][:10] == first["trainLoss"][:10]
    assert [p["loss"] for p in second["trainLoss"][10:]] == pytest.approx(
        [p["loss"] for p in first["trainLoss"][10:]], rel=1e-4
    )

    # A checkpoint from a different configuration is refused, not guessed at.
    other = base_env(storage, tiny_model_dir, hyperparams={"loraDropout": 0, "loraR": 16})
    code, events, _ = run_trainer(other, tmp_path / "third", capsys, ["--resume-from", str(checkpoint)])
    assert code == 10 and events[-1]["code"] == "resume_mismatch"


# --- one test per exit code -----------------------------------------------


def expect_failure(events: list, exit_code: int, code: str, phase) -> dict:
    failed = events[-1]
    assert failed["type"] == "failed", events
    assert (failed["exitCode"], failed["code"], failed["phase"]) == (exit_code, code, phase)
    assert "completed" not in types(events) and "uploaded" not in types(events)
    return failed


def test_exit_10_qlora_without_cuda(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir, METHOD="qlora"), tmp_path / "work", capsys)
    assert code == 10
    failed = expect_failure(events, 10, "qlora_requires_cuda", None)
    assert "CUDA" in failed["message"] and "METHOD=lora" in failed["message"]
    # Refused before anything was fetched, and the API was told.
    assert storage.count("GET", "/dataset") == 0 and storage.uploads == {}
    assert storage.callback_events()[-1]["code"] == "qlora_requires_cuda"


def test_exit_10_bad_hyperparameter_is_reported_to_the_callback(storage, tiny_model_dir, tmp_path, capsys):
    env = base_env(storage, tiny_model_dir, hyperparams={"learningRate": 5})
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 10
    failed = expect_failure(events, 10, "invalid_hyperparameter", None)
    assert failed["field"] == "learningRate"
    assert types(events) == ["failed"]
    assert storage.callback_events() == [{**failed, "jobId": "job_test_1"}]
    assert storage.count("GET", "/dataset") == 0


def test_exit_10_missing_variable(storage, tiny_model_dir, tmp_path, capsys):
    env = base_env(storage, tiny_model_dir, ADAPTER_UPLOAD_URL=None)
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 10
    assert expect_failure(events, 10, "missing_env", None)["field"] == "ADAPTER_UPLOAD_URL"


def test_exit_10_target_modules_the_model_does_not_have(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(storage, tiny_model_dir, hyperparams={"targetModules": ["c_attn"]})
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 10
    expect_failure(events, 10, "target_modules_not_found", "load_model")


def test_exit_11_dataset_url_answers_404(storage, tiny_model_dir, tmp_path, capsys):
    code, events, out = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 11
    failed = expect_failure(events, 11, "dataset_download_failed", "download_dataset")
    assert failed["httpStatus"] == 404
    assert_no_secret_in(out)


def test_exit_11_empty_dataset(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = b"\n"
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 11
    expect_failure(events, 11, "dataset_empty", "tokenize")


def test_exit_11_malformed_dataset(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes() + b'{"instruction": "broken", \n'
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 11
    assert expect_failure(events, 11, "dataset_parse_error", "tokenize")["row"] == 41


def test_exit_11_unknown_format(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = jsonl_bytes([{"question": "a", "answer": "b"}])
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 11
    expect_failure(events, 11, "dataset_unknown_format", "tokenize")


def test_exit_11_checksum_mismatch(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(storage, tiny_model_dir, DATASET_SHA256="0" * 64)
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 11
    expect_failure(events, 11, "dataset_checksum_mismatch", "download_dataset")


def test_exit_12_base_model_not_found(storage, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(storage, str(tmp_path / "no-such-model"))
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 12
    failed = expect_failure(events, 12, "base_model_not_found", "load_model")
    assert "HF_TOKEN" in failed["message"]
    assert storage.uploads == {}


def test_exit_12_hub_model_while_the_hub_is_unreachable(storage, tmp_path, capsys):
    """A Hub id with the Hub switched off (as this suite runs) is the same
    failure a node without a route to huggingface.co would see."""
    storage.objects["/dataset"] = fixture_bytes()
    env = base_env(storage, "wheelsai-tests/model-that-is-not-cached")
    code, events, _ = run_trainer(env, tmp_path / "work", capsys)
    assert code == 12
    expect_failure(events, 12, "base_model_download_failed", "load_model")


def test_exit_13_out_of_gpu_memory(storage, tiny_model_dir, tmp_path, capsys, monkeypatch):
    import torch

    def out_of_memory(*_args, **_kwargs):
        raise torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")

    storage.objects["/dataset"] = fixture_bytes()
    monkeypatch.setattr(runner, "forward_loss", out_of_memory)
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 13
    expect_failure(events, 13, "gpu_out_of_memory", "train")
    assert storage.uploads == {}


def test_exit_14_loss_is_not_finite(storage, tiny_model_dir, tmp_path, capsys, monkeypatch):
    real = runner.forward_loss
    calls = {"n": 0}

    def diverging(model, batch, device):
        calls["n"] += 1
        loss = real(model, batch, device)
        return loss * float("nan") if calls["n"] == 3 else loss

    storage.objects["/dataset"] = fixture_bytes()
    monkeypatch.setattr(runner, "forward_loss", diverging)
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 14
    failed = expect_failure(events, 14, "loss_not_finite", "train")
    assert failed["step"] == 3
    # Two good steps were taken; a diverged run uploads nothing.
    assert storage.uploads == {}


def test_exit_20_adapter_upload_fails(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    storage.status["/adapter"] = 500
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 20
    failed = expect_failure(events, 20, "adapter_upload_failed", "upload")
    assert failed["httpStatus"] == 500
    assert storage.count("PUT", "/adapter") == 3 and storage.count("PUT", "/metrics") == 0
    # The adapter is still on disk for whoever inspects the node.
    assert os.path.isfile(tmp_path / "work" / "out" / "adapter.tar.gz")


def test_exit_20_metrics_upload_fails_after_the_adapter_went_up(storage, tiny_model_dir, tmp_path, capsys):
    storage.objects["/dataset"] = fixture_bytes()
    storage.status["/metrics"] = 403
    code, events, _ = run_trainer(base_env(storage, tiny_model_dir), tmp_path / "work", capsys)
    assert code == 20
    expect_failure(events, 20, "metrics_upload_failed", "upload")
    assert "/adapter" in storage.uploads


def test_exit_1_unexpected_error_is_reported_without_secrets(storage, tiny_model_dir, tmp_path, capsys, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("driver fell over while reading sig=datasetsignature123")

    storage.objects["/dataset"] = fixture_bytes()
    monkeypatch.setattr(runner, "forward_loss", broken)
    capsys.readouterr()
    code = runner.main(["--device", "cpu", "--work-dir", str(tmp_path / "work")], base_env(storage, tiny_model_dir))
    captured = capsys.readouterr()
    events = [e for e in map(parse_event_line, captured.out.splitlines()) if e]
    assert code == 1
    failed = expect_failure(events, 1, "unexpected", "train")
    assert failed["message"].startswith("RuntimeError: driver fell over")
    assert "Traceback" in captured.err
    assert_no_secret_in(captured.out + captured.err)


# --- the real entry point, as a process -----------------------------------


def subprocess_env(env: dict) -> dict:
    merged = {name: os.environ[name] for name in ("PATH", "HOME", "LANG") if name in os.environ}
    merged.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    merged.update(env)
    return merged


def test_exit_code_of_the_process_is_the_contract_code(storage, tiny_model_dir, tmp_path):
    env = subprocess_env(base_env(storage, tiny_model_dir, METHOD="full"))
    result = subprocess.run(
        [sys.executable, TRAIN_SCRIPT, "--device", "cpu", "--work-dir", str(tmp_path / "work")],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 10
    events = [e for e in map(parse_event_line, result.stdout.splitlines()) if e]
    assert events[-1]["code"] == "unsupported_method"


def test_exit_30_sigterm_during_training(storage, tiny_model_dir, tmp_path):
    # Enough rows that training is still going when the signal lands.
    storage.objects["/dataset"] = fixture_bytes() * 50
    env = subprocess_env(base_env(storage, tiny_model_dir, hyperparams={"epochs": 10, "batchSize": 1}))
    process = subprocess.Popen(
        [sys.executable, TRAIN_SCRIPT, "--device", "cpu", "--work-dir", str(tmp_path / "work")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    lines = []
    try:
        for line in process.stdout:
            lines.append(line)
            event = parse_event_line(line.strip())
            if event and event["type"] == "step":
                process.send_signal(signal.SIGTERM)
                break
        rest, _ = process.communicate(timeout=60)
    finally:
        if process.poll() is None:
            process.kill()
    lines.extend(rest.splitlines())
    events = [e for e in (parse_event_line(line.strip()) for line in lines) if e]
    assert process.returncode == 30
    failed = events[-1]
    assert (failed["type"], failed["exitCode"], failed["code"]) == ("failed", 30, "interrupted")
    assert failed["phase"] == "train" and failed["signal"] == "SIGTERM"
    assert "completed" not in types(events)
    # The stop reached the API before the process went away.
    assert storage.callback_events()[-1]["code"] == "interrupted"
    assert storage.uploads == {}
