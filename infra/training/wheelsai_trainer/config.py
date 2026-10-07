"""Inputs of a run: environment variables only, validated before anything
is downloaded.

The API validates the same bounds with zod before it submits a job. They are
checked again here because the container is the last place a bad value can
be refused cheaply: a job definition is confidential and immutable once
submitted, and a wrong hyperparameter found after the model is loaded has
already cost the setup time.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit

from .errors import ConfigError

METHODS = ("lora", "qlora")
DATASET_FORMATS = ("alpaca", "sharegpt", "completion", "text", "auto")
DATASET_FILE_TYPES = ("jsonl", "csv", "parquet")
LORA_RANKS = (4, 8, 16, 32, 64)
ALL_LINEAR = "all-linear"
MAX_TARGET_MODULES = 12
TARGET_MODULE_PATTERN = re.compile(r"^[a-z_]+$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

# Rows at which a held-out split is taken when evalSplit is not given.
DEFAULT_EVAL_MIN_ROWS = 200
DEFAULT_EVAL_SPLIT = 0.05

# Every variable the container reads. Anything else in the environment is
# ignored; nothing is read from files or arguments except --device,
# --work-dir and --resume-from, which the image's ENTRYPOINT never sets.
ENV_NAMES = (
    "JOB_ID",
    "BASE_MODEL",
    "HF_TOKEN",
    "METHOD",
    "DATASET_URL",
    "DATASET_FORMAT",
    "DATASET_FILE_TYPE",
    "DATASET_SHA256",
    "ADAPTER_UPLOAD_URL",
    "METRICS_UPLOAD_URL",
    "CALLBACK_URL",
    "CALLBACK_SECRET",
    "HYPERPARAMS",
    "MAX_RUNTIME_SECONDS",
)


@dataclass(frozen=True)
class Hyperparams:
    """Training settings, in the camelCase the API and metrics.json use."""

    epochs: int = 3
    batchSize: int = 4
    gradientAccumulationSteps: int = 4
    learningRate: float = 2e-4
    warmupRatio: float = 0.03
    loraR: int = 16
    loraAlpha: int = 32
    loraDropout: float = 0.05
    targetModules: Any = ALL_LINEAR  # "all-linear" or a tuple of module names
    maxSeqLength: int = 1024
    maxSteps: int | None = None
    # None means "decide from the row count": 0.05 at 200 rows or more, else 0.
    evalSplit: float | None = None
    seed: int = 42

    def to_json(self) -> dict:
        out = asdict(self)
        if isinstance(self.targetModules, tuple):
            out["targetModules"] = list(self.targetModules)
        return out


@dataclass(frozen=True)
class TrainerConfig:
    # repr=False on everything that is or carries a credential, so a stray
    # print or a traceback's locals cannot put one in the job's logs.
    job_id: str
    base_model: str
    method: str
    dataset_url: str = field(repr=False)
    dataset_format: str
    dataset_file_type: str
    adapter_upload_url: str = field(repr=False)
    metrics_upload_url: str = field(repr=False)
    hyperparams: Hyperparams
    hf_token: str | None = field(default=None, repr=False)
    dataset_sha256: str | None = None
    callback_url: str | None = field(default=None, repr=False)
    callback_secret: str | None = field(default=None, repr=False)
    max_runtime_seconds: int | None = None
    # Strings that must never reach stdout, a callback or metrics.json.
    secrets: tuple = field(default_factory=tuple, repr=False, compare=False)


def _is_bool(value: Any) -> bool:
    # bool is a subclass of int; `true` must not pass as the integer 1.
    return isinstance(value, bool)


def _int(name: str, value: Any, low: int, high: int) -> int:
    if _is_bool(value) or not isinstance(value, int):
        raise ConfigError(f"{name} must be an integer", code="invalid_hyperparameter", field=name)
    if value < low or value > high:
        raise ConfigError(
            f"{name} must be between {low} and {high}", code="invalid_hyperparameter", field=name
        )
    return value


def _number(name: str, value: Any, low: float, high: float) -> float:
    if _is_bool(value) or not isinstance(value, (int, float)):
        raise ConfigError(f"{name} must be a number", code="invalid_hyperparameter", field=name)
    value = float(value)
    # NaN compares false to everything, so test the accepted range directly.
    if not (low <= value <= high):
        raise ConfigError(
            f"{name} must be between {low} and {high}", code="invalid_hyperparameter", field=name
        )
    return value


def parse_hyperparams(raw: str | None) -> Hyperparams:
    """HYPERPARAMS is one JSON object. Unknown keys are refused: a misspelt
    key silently replaced by its default would train something other than
    what the user was shown and charged for."""
    if raw is None or raw.strip() == "":
        return Hyperparams()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ConfigError(f"HYPERPARAMS is not valid JSON: {error.msg}", code="invalid_hyperparams_json")
    if not isinstance(data, dict):
        raise ConfigError("HYPERPARAMS must be a JSON object", code="invalid_hyperparams_json")

    known = set(Hyperparams.__dataclass_fields__)
    unknown = sorted(set(data) - known)
    if unknown:
        raise ConfigError(
            f"HYPERPARAMS has unknown keys: {', '.join(unknown)}",
            code="unknown_hyperparameter",
            fields=unknown,
        )

    values: dict[str, Any] = {}
    if "epochs" in data:
        values["epochs"] = _int("epochs", data["epochs"], 1, 10)
    if "batchSize" in data:
        values["batchSize"] = _int("batchSize", data["batchSize"], 1, 16)
    if "gradientAccumulationSteps" in data:
        values["gradientAccumulationSteps"] = _int(
            "gradientAccumulationSteps", data["gradientAccumulationSteps"], 1, 32
        )
    if "learningRate" in data:
        values["learningRate"] = _number("learningRate", data["learningRate"], 1e-6, 1e-3)
    if "warmupRatio" in data:
        values["warmupRatio"] = _number("warmupRatio", data["warmupRatio"], 0.0, 0.2)
    if "loraR" in data:
        rank = data["loraR"]
        if _is_bool(rank) or rank not in LORA_RANKS:
            raise ConfigError(
                "loraR must be one of 4, 8, 16, 32, 64", code="invalid_hyperparameter", field="loraR"
            )
        values["loraR"] = rank
    if "loraAlpha" in data:
        values["loraAlpha"] = _int("loraAlpha", data["loraAlpha"], 1, 128)
    if "loraDropout" in data:
        values["loraDropout"] = _number("loraDropout", data["loraDropout"], 0.0, 0.3)
    if "targetModules" in data:
        values["targetModules"] = _target_modules(data["targetModules"])
    if "maxSeqLength" in data:
        values["maxSeqLength"] = _int("maxSeqLength", data["maxSeqLength"], 128, 4096)
    if "maxSteps" in data and data["maxSteps"] is not None:
        values["maxSteps"] = _int("maxSteps", data["maxSteps"], 1, 20000)
    if "evalSplit" in data and data["evalSplit"] is not None:
        values["evalSplit"] = _number("evalSplit", data["evalSplit"], 0.0, 0.2)
    if "seed" in data:
        values["seed"] = _int("seed", data["seed"], 0, 2**31 - 1)
    return Hyperparams(**values)


def _target_modules(value: Any) -> Any:
    if value == ALL_LINEAR:
        return ALL_LINEAR
    if not isinstance(value, list) or not value:
        raise ConfigError(
            'targetModules must be "all-linear" or a list of module names',
            code="invalid_hyperparameter",
            field="targetModules",
        )
    if len(value) > MAX_TARGET_MODULES:
        raise ConfigError(
            f"targetModules takes at most {MAX_TARGET_MODULES} names",
            code="invalid_hyperparameter",
            field="targetModules",
        )
    for name in value:
        if not isinstance(name, str) or not TARGET_MODULE_PATTERN.match(name):
            raise ConfigError(
                "targetModules names must match ^[a-z_]+$",
                code="invalid_hyperparameter",
                field="targetModules",
            )
    if len(set(value)) != len(value):
        raise ConfigError(
            "targetModules must not repeat a name", code="invalid_hyperparameter", field="targetModules"
        )
    return tuple(value)


def _required(env: Mapping[str, str], name: str) -> str:
    value = (env.get(name) or "").strip()
    if not value:
        raise ConfigError(f"{name} is required", code="missing_env", field=name)
    return value


def _optional(env: Mapping[str, str], name: str) -> str | None:
    value = (env.get(name) or "").strip()
    return value or None


def _url(env: Mapping[str, str], name: str, required: bool = True) -> str | None:
    value = _required(env, name) if required else _optional(env, name)
    if value is None:
        return None
    parts = urlsplit(value)
    # http is accepted beside https for the development-only local storage
    # driver and the loopback test server. file:, ftp: and the rest are not:
    # the container must not be steerable into reading its own disk.
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ConfigError(f"{name} must be an http(s) URL", code="invalid_url", field=name)
    return value


def _url_secrets(url: str | None) -> list[str]:
    """The query string of a signed URL is its credential."""
    if not url:
        return []
    query = urlsplit(url).query
    return [query] if len(query) >= 8 else []


def load_config(env: Mapping[str, str]) -> TrainerConfig:
    """Parse and validate the whole environment, or raise ConfigError (exit 10)."""
    job_id = _required(env, "JOB_ID")
    if len(job_id) > 128:
        raise ConfigError("JOB_ID is too long", code="invalid_env", field="JOB_ID")
    base_model = _required(env, "BASE_MODEL")

    method = _required(env, "METHOD").lower()
    if method not in METHODS:
        raise ConfigError(
            f"METHOD must be one of {', '.join(METHODS)}", code="unsupported_method", field="METHOD"
        )

    dataset_format = (_optional(env, "DATASET_FORMAT") or "auto").lower()
    if dataset_format not in DATASET_FORMATS:
        raise ConfigError(
            f"DATASET_FORMAT must be one of {', '.join(DATASET_FORMATS)}",
            code="invalid_env",
            field="DATASET_FORMAT",
        )
    file_type = _required(env, "DATASET_FILE_TYPE").lower()
    if file_type not in DATASET_FILE_TYPES:
        raise ConfigError(
            f"DATASET_FILE_TYPE must be one of {', '.join(DATASET_FILE_TYPES)}",
            code="invalid_env",
            field="DATASET_FILE_TYPE",
        )
    sha256 = _optional(env, "DATASET_SHA256")
    if sha256 is not None:
        sha256 = sha256.lower()
        if not SHA256_PATTERN.match(sha256):
            raise ConfigError(
                "DATASET_SHA256 must be 64 hex characters", code="invalid_env", field="DATASET_SHA256"
            )

    dataset_url = _url(env, "DATASET_URL")
    adapter_url = _url(env, "ADAPTER_UPLOAD_URL")
    metrics_url = _url(env, "METRICS_UPLOAD_URL")

    # Callbacks are optional as a pair: a run with no callback URL still
    # prints every event. A URL without its secret would post unsigned
    # bodies the API must reject, so that half-configuration is refused.
    callback_url = _url(env, "CALLBACK_URL", required=False)
    callback_secret = _optional(env, "CALLBACK_SECRET")
    if callback_url and not callback_secret:
        raise ConfigError(
            "CALLBACK_SECRET is required when CALLBACK_URL is set",
            code="missing_env",
            field="CALLBACK_SECRET",
        )
    if callback_secret and not callback_url:
        callback_secret = None

    max_runtime = _optional(env, "MAX_RUNTIME_SECONDS")
    max_runtime_seconds = None
    if max_runtime is not None:
        if not re.fullmatch(r"[0-9]{1,9}", max_runtime) or int(max_runtime) < 60:
            raise ConfigError(
                "MAX_RUNTIME_SECONDS must be a whole number of seconds, 60 or more",
                code="invalid_env",
                field="MAX_RUNTIME_SECONDS",
            )
        max_runtime_seconds = int(max_runtime)

    hyperparams = parse_hyperparams(env.get("HYPERPARAMS"))
    hf_token = _optional(env, "HF_TOKEN")

    secrets = [s for s in (hf_token, callback_secret) if s]
    for url in (dataset_url, adapter_url, metrics_url, callback_url):
        secrets.extend(_url_secrets(url))

    return TrainerConfig(
        job_id=job_id,
        base_model=base_model,
        method=method,
        dataset_url=dataset_url,
        dataset_format=dataset_format,
        dataset_file_type=file_type,
        adapter_upload_url=adapter_url,
        metrics_upload_url=metrics_url,
        hyperparams=hyperparams,
        hf_token=hf_token,
        dataset_sha256=sha256,
        callback_url=callback_url,
        callback_secret=callback_secret,
        max_runtime_seconds=max_runtime_seconds,
        secrets=tuple(secrets),
    )
