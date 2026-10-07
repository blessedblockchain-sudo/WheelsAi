"""Shared fixtures for the offline suite.

Nothing here leaves the machine: the Hub is switched off before any library
is imported, a guard refuses every socket connection that is not loopback,
the base model is a two-layer random Llama built in a temp directory, and
one local HTTP server stands in for the dataset URL, the two upload URLs
and the callback endpoint.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Before transformers or huggingface_hub is imported anywhere.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

TRAINING_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, TRAINING_DIR)

import pytest  # noqa: E402

FIXTURE_JSONL = os.path.join(TRAINING_DIR, "fixtures", "tiny.jsonl")
TRAIN_SCRIPT = os.path.join(TRAINING_DIR, "train.py")
CALLBACK_SECRET = "test-callback-secret-not-a-real-one"

CHATML_TEMPLATE = (
    "{% for message in messages %}"
    "{{ '<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n' }}"
    "{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"
)

# The shape of Mistral-7B-Instruct-v0.2's template: user and assistant must
# alternate and any other role raises.
STRICT_TEMPLATE = (
    "{{ bos_token }}"
    "{% for message in messages %}"
    "{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}"
    "{{ raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}"
    "{% endif %}"
    "{% if message['role'] == 'user' %}{{ '[INST] ' + message['content'] + ' [/INST]' }}"
    "{% elif message['role'] == 'assistant' %}{{ ' ' + message['content'] + eos_token }}"
    "{% else %}{{ raise_exception('Only user and assistant roles are supported!') }}"
    "{% endif %}"
    "{% endfor %}"
)

# A template that drops a system message without complaint.
SILENT_TEMPLATE = (
    "{% for message in messages %}"
    "{% if message['role'] != 'system' %}"
    "{{ '<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n' }}"
    "{% endif %}"
    "{% endfor %}"
    "{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}"
)

SPECIAL_TOKENS = ["<|endoftext|>", "<|im_start|>", "<|im_end|>", "<s>", "</s>", "[INST]", "[/INST]"]


@pytest.fixture(autouse=True)
def _loopback_only(monkeypatch):
    """Fail any test that tries to reach a host other than this one."""
    real_connect = socket.socket.connect

    def guarded(self, address):
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and not (host.startswith("127.") or host in ("::1", "localhost")):
            raise AssertionError(f"offline suite tried to connect to {host}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", guarded)


@pytest.fixture(autouse=True)
def _fast_retries(monkeypatch):
    """Retries keep their count; only the waiting between them is removed."""
    from wheelsai_trainer import callbacks, upload

    monkeypatch.setattr(callbacks, "CALLBACK_BACKOFF_SECONDS", (0.01, 0.01))
    monkeypatch.setattr(callbacks, "CALLBACK_TIMEOUT_SECONDS", 2.0)
    monkeypatch.setattr(upload, "TRANSFER_BACKOFF_SECONDS", (0.01, 0.01))


def fixture_rows() -> list:
    with open(FIXTURE_JSONL, "r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _train_bpe():
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

    corpus = []
    for row in fixture_rows():
        corpus.extend([row["instruction"], row.get("input", ""), row["output"]])
    corpus.extend(["system user assistant human gpt", "You are a careful assistant. Answer in one line."])
    tokenizer = Tokenizer(models.BPE(unk_token=None))
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tokenizer.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=500,
        special_tokens=SPECIAL_TOKENS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tokenizer.train_from_iterator(corpus, trainer)
    return tokenizer


def make_tokenizer(template: str | None = CHATML_TEMPLATE, *, strict: bool = False, pad: str | None = None):
    """A fast tokenizer trained on the fixture. No pad token unless asked,
    which is the Llama situation the trainer must cope with."""
    from transformers import PreTrainedTokenizerFast

    kwargs = {"tokenizer_object": _train_bpe()}
    if strict:
        kwargs.update(bos_token="<s>", eos_token="</s>")
    else:
        kwargs.update(eos_token="<|im_end|>")
    if pad:
        kwargs["pad_token"] = pad
    tokenizer = PreTrainedTokenizerFast(**kwargs)
    tokenizer.chat_template = template
    return tokenizer


def build_tiny_model(directory: str, tokenizer) -> str:
    """A two-layer random Llama, saved with its tokenizer like a Hub snapshot."""
    import torch
    from transformers import LlamaConfig, LlamaForCausalLM

    torch.manual_seed(0)
    config = LlamaConfig(
        vocab_size=len(tokenizer),
        hidden_size=64,
        intermediate_size=128,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=4,
        max_position_embeddings=512,
        bos_token_id=tokenizer.bos_token_id,
        eos_token_id=tokenizer.eos_token_id,
        pad_token_id=None,
    )
    model = LlamaForCausalLM(config)
    model.save_pretrained(directory, safe_serialization=True)
    tokenizer.save_pretrained(directory)
    return directory


@pytest.fixture(scope="session")
def tiny_model_dir(tmp_path_factory) -> str:
    directory = str(tmp_path_factory.mktemp("tiny-llama"))
    return build_tiny_model(directory, make_tokenizer())


@pytest.fixture(scope="session")
def strict_model_dir(tmp_path_factory) -> str:
    """Same model, with a template that rejects the system role."""
    directory = str(tmp_path_factory.mktemp("tiny-llama-strict"))
    return build_tiny_model(directory, make_tokenizer(STRICT_TEMPLATE, strict=True))


class StorageServer:
    """Loopback stand-in for object storage and the API's callback route."""

    def __init__(self):
        self.objects: dict = {}  # path -> bytes served on GET
        self.uploads: dict = {}  # path -> {"body", "headers"} from PUT
        self.callbacks: list = []  # {"headers", "raw"} from POST, in arrival order
        self.status: dict = {}  # path -> forced status code
        self.status_sequence: dict = {}  # path -> list of status codes, consumed in order
        self.requests: list = []  # (method, path) of everything received
        self._lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def _path(self) -> str:
                return self.path.split("?", 1)[0]

            def _forced(self) -> int | None:
                path = self._path()
                with owner._lock:
                    sequence = owner.status_sequence.get(path)
                    if sequence:
                        return sequence.pop(0)
                    return owner.status.get(path)

            def _reply(self, status: int, body: bytes = b"") -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def do_GET(self):
                with owner._lock:
                    owner.requests.append(("GET", self.path))
                forced = self._forced()
                if forced and forced >= 300:
                    return self._reply(forced)
                body = owner.objects.get(self._path())
                if body is None:
                    return self._reply(404)
                self._reply(200, body)

            def do_PUT(self):
                body = self._body()
                with owner._lock:
                    owner.requests.append(("PUT", self.path))
                forced = self._forced()
                if forced and forced >= 300:
                    return self._reply(forced)
                with owner._lock:
                    owner.uploads[self._path()] = {"body": body, "headers": dict(self.headers.items())}
                self._reply(200)

            def do_POST(self):
                body = self._body()
                with owner._lock:
                    owner.requests.append(("POST", self.path))
                    owner.callbacks.append({"headers": dict(self.headers.items()), "raw": body})
                forced = self._forced()
                self._reply(forced or 200)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def url(self, path: str, query: str = "") -> str:
        return f"{self.base_url}{path}" + (f"?{query}" if query else "")

    def count(self, method: str, path: str) -> int:
        with self._lock:
            return sum(1 for m, p in self.requests if m == method and p.split("?", 1)[0] == path)

    def callback_events(self) -> list:
        with self._lock:
            return [json.loads(entry["raw"]) for entry in self.callbacks]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture()
def storage():
    server = StorageServer()
    yield server
    server.close()


def jsonl_bytes(rows: list) -> bytes:
    return "".join(json.dumps(row) + "\n" for row in rows).encode("utf-8")


def base_env(storage: StorageServer, model_dir: str, **overrides) -> dict:
    """A complete, valid environment for one run against the local server.
    The URLs carry a query string the way signed URLs do."""
    hyperparams = {
        "epochs": 2,
        "batchSize": 4,
        "gradientAccumulationSteps": 1,
        "learningRate": 1e-3,
        "maxSeqLength": 128,
        "loraR": 8,
        "loraAlpha": 16,
        "evalSplit": 0,
    }
    hyperparams.update(overrides.pop("hyperparams", {}))
    env = {
        "JOB_ID": "job_test_1",
        "BASE_MODEL": model_dir,
        "METHOD": "lora",
        "DATASET_URL": storage.url("/dataset", "sig=datasetsignature123"),
        "DATASET_FORMAT": "auto",
        "DATASET_FILE_TYPE": "jsonl",
        "ADAPTER_UPLOAD_URL": storage.url("/adapter", "sig=adaptersignature456"),
        "METRICS_UPLOAD_URL": storage.url("/metrics", "sig=metricssignature789"),
        "CALLBACK_URL": storage.url("/callback"),
        "CALLBACK_SECRET": CALLBACK_SECRET,
        "HYPERPARAMS": json.dumps(hyperparams),
    }
    env.update(overrides)
    return {name: value for name, value in env.items() if value is not None}


def run_trainer(env: dict, work_dir, capsys, extra_args: list | None = None) -> tuple:
    """Run the trainer in this process. Returns (exit code, events, stdout)."""
    from wheelsai_trainer.events import parse_event_line
    from wheelsai_trainer.runner import main

    capsys.readouterr()
    code = main(["--device", "cpu", "--work-dir", str(work_dir)] + (extra_args or []), env)
    out = capsys.readouterr().out
    events = [event for event in (parse_event_line(line) for line in out.splitlines()) if event]
    return code, events, out
