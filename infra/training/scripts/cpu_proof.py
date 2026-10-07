#!/usr/bin/env python
"""CPU realism run: train.py against a small real model, start to finish.

The offline suite proves the contract on a random model. This shows the same
code doing useful work on a real one: the loss falling over a few dozen
steps, and the uploaded adapter changing what the base model says.

    python scripts/cpu_proof.py                      # SmolLM2-135M-Instruct
    python scripts/cpu_proof.py --model <hf id> --epochs 3

It downloads the base model from Hugging Face once (about 270 MB for the
default) into HF_HOME, starts a loopback HTTP server for the dataset, the
two uploads and the callbacks, runs train.py as a separate process exactly
as the image's ENTRYPOINT would, then reloads base + adapter with peft.
Nothing is sent anywhere except the model download.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TRAINING_DIR = os.path.dirname(HERE)
SECRET = "cpu-proof-callback-secret"
PROMPT = "Add 7 and 8, in WheelsAI report style."


class Store:
    def __init__(self, dataset: bytes):
        self.dataset = dataset
        self.uploads: dict = {}
        self.callbacks: list = []


def serve(store: Store) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def _reply(self, status: int, body: bytes = b"") -> None:
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._reply(200, store.dataset) if self.path.startswith("/dataset") else self._reply(404)

        def do_PUT(self):
            store.uploads[self.path.split("?")[0]] = self.rfile.read(int(self.headers["Content-Length"]))
            self._reply(200)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            store.callbacks.append((self.headers.get("X-WheelsAI-Signature", ""), raw))
            self._reply(200)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def signature_ok(header: str, raw: bytes) -> bool:
    parts = dict(part.split("=", 1) for part in header.split(","))
    expected = hmac.new(SECRET.encode(), parts["t"].encode() + b"." + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))


def generate(model, tokenizer, prompt: str) -> str:
    import torch

    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True
    )
    encoded = tokenizer(text, return_tensors="pt", add_special_tokens=False)
    with torch.no_grad():
        output = model.generate(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            max_new_tokens=32,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id,
        )
    return tokenizer.decode(output[0, encoded["input_ids"].shape[1] :], skip_special_tokens=True).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    parser.add_argument("--dataset", default=os.path.join(TRAINING_DIR, "fixtures", "tiny.jsonl"))
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    args = parser.parse_args()

    with open(args.dataset, "rb") as handle:
        dataset = handle.read()
    store = Store(dataset)
    server = serve(store)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    work_dir = tempfile.mkdtemp(prefix="wheelsai-cpu-proof-")

    env = dict(os.environ)
    env.update(
        JOB_ID="cpu-proof",
        BASE_MODEL=args.model,
        METHOD="lora",
        DATASET_URL=f"{base}/dataset",
        DATASET_FORMAT="auto",
        DATASET_FILE_TYPE="jsonl",
        DATASET_SHA256=hashlib.sha256(dataset).hexdigest(),
        ADAPTER_UPLOAD_URL=f"{base}/adapter",
        METRICS_UPLOAD_URL=f"{base}/metrics",
        CALLBACK_URL=f"{base}/callback",
        CALLBACK_SECRET=SECRET,
        HYPERPARAMS=json.dumps(
            {
                "epochs": args.epochs,
                "batchSize": 4,
                "gradientAccumulationSteps": 1,
                "learningRate": args.learning_rate,
                "maxSeqLength": 128,
                "evalSplit": 0.1,
            }
        ),
    )
    env.pop("HF_TOKEN", None)

    print(f"model      {args.model}")
    print(f"dataset    {os.path.relpath(args.dataset, TRAINING_DIR)} ({len(dataset)} bytes)")
    print(f"work dir   {work_dir}")
    print("--- train.py output ---", flush=True)
    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, os.path.join(TRAINING_DIR, "train.py"), "--device", "cpu", "--work-dir", work_dir],
        env=env,
    )
    wall = time.monotonic() - started
    print("--- end of train.py output ---")
    print(f"exit code  {result.returncode}   wall clock {wall:.1f}s")
    if result.returncode != 0:
        shutil.rmtree(work_dir, ignore_errors=True)
        return result.returncode

    metrics = json.loads(store.uploads["/metrics"])
    archive = store.uploads["/adapter"]
    print("\nloss by step")
    for point in metrics["trainLoss"]:
        print(f"  step {point['step']:>3}  loss {point['loss']:.4f}  lr {point['lr']:.2e}")
    print("eval loss   " + ", ".join(f"step {p['step']}: {p['loss']:.4f}" for p in metrics["evalLoss"]))
    first, final = metrics["trainLoss"][0]["loss"], metrics["finalTrainLoss"]
    print(f"first step {first:.4f} -> mean of last 10 steps {final:.4f}")
    print(f"rows       {metrics['rows']}")
    print(f"timings    {metrics['timings']}")
    print(f"throughput {metrics['trainTokensPerSecond']} tokens/s over {metrics['trainTokens']} tokens")
    print(f"adapter    {len(archive)} bytes (tar.gz), sha256 {hashlib.sha256(archive).hexdigest()}")
    print(f"           r={metrics['adapter']['r']} alpha={metrics['adapter']['alpha']} "
          f"trainable={metrics['adapter']['trainableParameters']} targets={metrics['adapter']['targetModules']}")
    good = sum(1 for header, raw in store.callbacks if signature_ok(header, raw))
    print(f"callbacks  {len(store.callbacks)} received, {good} with a valid signature")

    adapter_dir = os.path.join(work_dir, "reloaded-adapter")
    os.makedirs(adapter_dir)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        print(f"archive    {tar.getnames()}")
        tar.extractall(adapter_dir)

    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model)
    print(f"\nprompt     {PROMPT}")
    print(f"base       {generate(model, tokenizer, PROMPT)!r}")
    tuned = PeftModel.from_pretrained(model, adapter_dir)
    tuned.eval()
    print(f"adapter    {generate(tuned, tokenizer, PROMPT)!r}")

    server.shutdown()
    shutil.rmtree(work_dir, ignore_errors=True)
    if not final < first:
        print("the loss did not fall")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
