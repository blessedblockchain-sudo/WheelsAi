#!/usr/bin/env python
"""CPU realism run: train.py against a small real model, start to finish.

The offline suite proves the contract on a random model. This shows the same
code doing useful work on a real one: the loss falling over a few dozen
steps, and the uploaded adapter changing what the base model says.

    python scripts/cpu_proof.py                      # SmolLM2-135M-Instruct
    python scripts/cpu_proof.py --model <hf id> --epochs 3
    python scripts/cpu_proof.py --image <reference>  # the same, inside the image

It downloads the base model from Hugging Face once (about 270 MB for the
default) into HF_HOME, starts a loopback HTTP server for the dataset, the
two uploads and the callbacks, runs train.py as a separate process with
--device cpu, then reloads base + adapter with peft. Nothing is sent
anywhere except the model download.

With --image the run happens inside that image, as the image's own user in
its own /workspace. It is started twice. First exactly as a GPU node starts
it, with no command: no GPU is handed to the container, so the image must
refuse in seconds with exit 10 (cuda_unavailable) and not train on the
processor.
Then with --device cpu, the one argument that lets it train here. The
container downloads the model itself, so this is also the check that the
image can do that as the user it runs as. It needs docker and host
networking (the container reaches the loopback server). No GPU is used:
what it proves is the image, not CUDA.

    python scripts/cpu_proof.py --image <reference> --hf-cache ~/.cache/wheelsai/hf

With --hf-cache the container downloads the model from this machine and not
from the internet: the loopback server answers as the hub (HF_ENDPOINT) from
that folder, a Hugging Face cache that already holds the model. The container
still fills its own model cache as its own user, which is the step a
read-only mount of a ready cache would hide. The reload at the end reads the
same folder and stays offline. Use it on a metered connection.

The run fails if the trainer had to move off a folder it could not write
(it says so on stderr): in the image as built, the image's user owns them.
With --user UID:GID the container is started as someone else, as some hosts
do, and then the move is what must happen.

The image is never pulled: a reference that is not on this machine is an
error, not a download of several gigabytes.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import io
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
TRAINING_DIR = os.path.dirname(HERE)
SECRET = "cpu-proof-callback-secret"
PROMPT = "Add 7 and 8, in WheelsAI report style."
# The refusal takes about two seconds; an image that is still running after
# this long is training on the processor.
REFUSAL_SECONDS = 120
MOVED = "cannot be written by uid"


HUB_FILE = re.compile(r"^/(?P<repo>[^/]+(?:/[^/]+)?)/resolve/(?P<revision>[^/]+)/(?P<name>.+)$")


class HubMirror:
    """A local Hugging Face cache, answered the way huggingface.co answers.

    Enough of the hub for transformers and peft to download a model: HEAD and
    GET on /<repo>/resolve/<revision>/<file>, with the headers huggingface_hub
    reads (ETag, X-Repo-Commit, Content-Length) and X-Error-Code for a file
    the model does not have.
    """

    def __init__(self, cache_dir: str):
        self.hub = os.path.join(os.path.abspath(os.path.expanduser(cache_dir)), "hub")
        self.served: set = set()
        self.absent: set = set()

    def folder(self, repo: str) -> str:
        return os.path.join(self.hub, "models--" + repo.replace("/", "--"))

    def find(self, url_path: str):
        """(status, headers, blob path or None) for a hub file, None for any other path."""
        match = HUB_FILE.match(url_path.split("?")[0])
        if not match:
            return None
        repo, revision = unquote(match["repo"]), unquote(match["revision"])
        name = posixpath.normpath(unquote(match["name"]))
        folder = self.folder(repo)
        if ".." in repo.split("/") or not os.path.isdir(folder):
            return 404, {"X-Error-Code": "RepoNotFound"}, None
        if "/" in revision or revision in ("", ".", ".."):
            return 404, {"X-Error-Code": "RevisionNotFound"}, None
        commit = revision
        ref = os.path.join(folder, "refs", revision)
        if os.path.isfile(ref):
            with open(ref) as handle:
                commit = handle.read().strip()
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            return 404, {"X-Error-Code": "RevisionNotFound"}, None
        headers = {"X-Repo-Commit": commit}
        target = os.path.join(folder, "snapshots", commit, name)
        # A snapshot entry is a link to blobs/<etag>. Nothing outside the
        # model's own folder is ever served.
        blob = os.path.realpath(target)
        inside = blob.startswith(os.path.realpath(folder) + os.sep)
        if name.startswith(("/", "..")) or not inside or not os.path.isfile(blob):
            self.absent.add(name)
            return 404, {**headers, "X-Error-Code": "EntryNotFound"}, None
        self.served.add(name)
        return 200, {**headers, "ETag": f'"{os.path.basename(blob)}"', "Accept-Ranges": "bytes"}, blob


class Store:
    def __init__(self, dataset: bytes, hub: HubMirror | None = None):
        self.dataset = dataset
        self.hub = hub
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

        def _hub(self, with_body: bool) -> bool:
            found = store.hub.find(self.path) if store.hub else None
            if found is None:
                return False
            status, headers, blob = found
            size = os.path.getsize(blob) if blob else 0
            start = 0
            asked = self.headers.get("Range", "")
            if blob and asked.startswith("bytes=") and asked[6:].rstrip("-").isdigit() and asked.endswith("-"):
                start = min(int(asked[6:-1]), size)
            self.send_response(206 if start else status)
            for key, value in headers.items():
                self.send_header(key, value)
            if start:
                self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
            self.send_header("Content-Length", str(size - start))
            self.end_headers()
            if blob and with_body:
                with open(blob, "rb") as handle:
                    handle.seek(start)
                    shutil.copyfileobj(handle, self.wfile)
            return True

        def do_HEAD(self):
            if not self._hub(with_body=False):
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()

        def do_GET(self):
            if self.path.startswith("/dataset"):
                self._reply(200, store.dataset)
            elif not self._hub(with_body=True):
                self._reply(404)

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
    parser.add_argument(
        "--image",
        default=None,
        metavar="REFERENCE",
        help="run inside this image with docker, started as a GPU node starts it, instead of train.py here",
    )
    parser.add_argument(
        "--user",
        default=None,
        metavar="UID:GID",
        help="with --image: start the container as this user, not the image's own (a host that does that)",
    )
    parser.add_argument(
        "--hf-cache",
        default=None,
        metavar="DIR",
        help="with --image: the container downloads the model from this local Hugging Face cache, not the internet",
    )
    args = parser.parse_args()
    if (args.hf_cache or args.user) and not args.image:
        parser.error("--hf-cache and --user are for a run inside an image (--image)")

    with open(args.dataset, "rb") as handle:
        dataset = handle.read()
    hub = HubMirror(args.hf_cache) if args.hf_cache else None
    if hub and not os.path.isdir(hub.folder(args.model)):
        parser.error(f"{args.hf_cache} does not hold {args.model}: run once without --image to download it")
    store = Store(dataset, hub)
    server = serve(store)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    work_dir = tempfile.mkdtemp(prefix="wheelsai-cpu-proof-")

    contract = dict(
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
    env = dict(os.environ)
    env.update(contract)
    env.pop("HF_TOKEN", None)

    if args.image:
        # -e NAME hands each value over from this process's environment, so
        # none of them is on a command line.
        as_a_node = ["docker", "run", "--rm", "--pull=never", "--network", "host"]
        if args.user:
            as_a_node += ["--user", args.user]
        for name in contract:
            as_a_node += ["-e", name]
        if args.hf_cache:
            # The loopback server is the hub: the model is downloaded into the
            # image's own cache by the image's own user, as on a node.
            env["HF_ENDPOINT"] = base
            as_a_node += ["-e", "HF_ENDPOINT"]
        container = f"wheelsai-cpu-proof-{os.getpid()}"
        # Nothing follows the image name: a job definition carries no command
        # either. No GPU is handed to the container, so the image has to
        # refuse, not train. An image that trains anyway is stopped.
        print("--- started as a node starts it, with no GPU ---", flush=True)
        first = as_a_node + ["--name", f"{container}-refusal", args.image]
        try:
            refusal = subprocess.run(first, env=env, capture_output=True, text=True, timeout=REFUSAL_SECONDS)
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "kill", f"{container}-refusal"], capture_output=True)
            print(f"the image was still running after {REFUSAL_SECONDS} s: it did not refuse to run without a GPU")
            shutil.rmtree(work_dir, ignore_errors=True)
            return 1
        sys.stdout.write(refusal.stdout)
        if refusal.returncode == 125:
            sys.stderr.write(refusal.stderr)
            print(f"docker could not start {args.image}: if it is not on this machine, build it; it is never pulled from here")
            shutil.rmtree(work_dir, ignore_errors=True)
            return 1
        refused = refusal.returncode == 10 and '"code":"cuda_unavailable"' in refusal.stdout
        print(f"exit code  {refusal.returncode}   {'refused, as it must' if refused else 'NOT the refusal expected'}")
        if not refused:
            sys.stderr.write(refusal.stderr)
            print("the image did not refuse to run without a GPU")
            shutil.rmtree(work_dir, ignore_errors=True)
            return 1
        store.callbacks.clear()
        command = as_a_node + ["--name", f"{container}-train", args.image, "--device", "cpu"]
    else:
        command = [sys.executable, os.path.join(TRAINING_DIR, "train.py"), "--device", "cpu", "--work-dir", work_dir]

    print(f"model      {args.model}")
    print(f"dataset    {os.path.relpath(args.dataset, TRAINING_DIR)} ({len(dataset)} bytes)")
    if args.image:
        print(f"image      {args.image}" + (f" as user {args.user}" if args.user else ""))
    else:
        print(f"work dir   {work_dir}")
    print("--- train.py output ---", flush=True)
    started = time.monotonic()
    result = subprocess.run(command, env=env, stderr=subprocess.PIPE, text=True)
    wall = time.monotonic() - started
    sys.stderr.write(result.stderr)
    sys.stderr.flush()
    print("--- end of train.py output ---")
    print(f"exit code  {result.returncode}   wall clock {wall:.1f}s")
    if result.returncode != 0:
        shutil.rmtree(work_dir, ignore_errors=True)
        return result.returncode
    if args.image and (MOVED in result.stderr) != bool(args.user):
        # A run that finished is not enough: the trainer works around a
        # folder it cannot write, which is exactly what a broken image has.
        if args.user:
            print(f"started as {args.user}, the trainer was expected to move off /workspace and did not say so")
        else:
            print("the image's own user could not write the image's own folders (see the line above)")
        shutil.rmtree(work_dir, ignore_errors=True)
        return 1

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
    if hub:
        print(f"model      {len(hub.served)} files downloaded from this machine: {sorted(hub.served)}")
        print(f"           asked for and not part of the model: {sorted(hub.absent)}")

    adapter_dir = os.path.join(work_dir, "reloaded-adapter")
    os.makedirs(adapter_dir)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        print(f"archive    {tar.getnames()}")
        tar.extractall(adapter_dir)

    if args.hf_cache:
        # Before the libraries are imported: they read both once, at import.
        os.environ["HF_HOME"] = os.path.abspath(os.path.expanduser(args.hf_cache))
        os.environ["HF_HUB_OFFLINE"] = "1"
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
