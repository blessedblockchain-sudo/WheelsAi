"""Environment parsing and hyperparameter bounds (exit 10 before any download)."""

from __future__ import annotations

import json

import pytest

from wheelsai_trainer.config import ENV_NAMES, Hyperparams, load_config, parse_hyperparams
from wheelsai_trainer.errors import EXIT_CONFIG, ConfigError

VALID_ENV = {
    "JOB_ID": "job_1",
    "BASE_MODEL": "microsoft/Phi-3-mini-4k-instruct",
    "METHOD": "qlora",
    "DATASET_URL": "https://bucket.example/datasets/a/data.jsonl?X-Amz-Signature=abcdef0123456789",
    "DATASET_FILE_TYPE": "jsonl",
    "ADAPTER_UPLOAD_URL": "https://bucket.example/adapters/a/adapter.tar.gz?X-Amz-Signature=1111222233334444",
    "METRICS_UPLOAD_URL": "https://bucket.example/adapters/a/metrics.json?X-Amz-Signature=5555666677778888",
}


def env(**changes) -> dict:
    merged = dict(VALID_ENV)
    merged.update(changes)
    return {name: value for name, value in merged.items() if value is not None}


def test_minimal_environment_takes_the_documented_defaults():
    cfg = load_config(env())
    assert cfg.method == "qlora"
    assert cfg.dataset_format == "auto"
    assert cfg.callback_url is None and cfg.callback_secret is None
    assert cfg.max_runtime_seconds is None
    assert cfg.hyperparams == Hyperparams()
    assert cfg.hyperparams.to_json() == {
        "epochs": 3,
        "batchSize": 4,
        "gradientAccumulationSteps": 4,
        "learningRate": 2e-4,
        "warmupRatio": 0.03,
        "loraR": 16,
        "loraAlpha": 32,
        "loraDropout": 0.05,
        "targetModules": "all-linear",
        "maxSeqLength": 1024,
        "maxSteps": None,
        "evalSplit": None,
        "seed": 42,
    }


def test_the_contract_lists_exactly_the_fourteen_variables():
    assert len(ENV_NAMES) == 14 and len(set(ENV_NAMES)) == 14


REQUIRED = [
    "JOB_ID",
    "BASE_MODEL",
    "METHOD",
    "DATASET_URL",
    "DATASET_FILE_TYPE",
    "ADAPTER_UPLOAD_URL",
    "METRICS_UPLOAD_URL",
]


@pytest.mark.parametrize("name", REQUIRED)
def test_each_required_variable_is_required(name):
    with pytest.raises(ConfigError) as caught:
        load_config(env(**{name: None}))
    assert caught.value.exit_code == EXIT_CONFIG
    assert caught.value.code == "missing_env"
    assert caught.value.details["field"] == name


@pytest.mark.parametrize(
    "changes, code",
    [
        ({"METHOD": "full"}, "unsupported_method"),
        ({"METHOD": "8bit"}, "unsupported_method"),
        ({"DATASET_FORMAT": "openai"}, "invalid_env"),
        ({"DATASET_FILE_TYPE": "json"}, "invalid_env"),
        ({"DATASET_SHA256": "abc"}, "invalid_env"),
        ({"DATASET_URL": "file:///etc/passwd"}, "invalid_url"),
        ({"ADAPTER_UPLOAD_URL": "s3://bucket/key"}, "invalid_url"),
        ({"METRICS_UPLOAD_URL": "not a url"}, "invalid_url"),
        ({"CALLBACK_URL": "https://api.example/cb"}, "missing_env"),
        ({"MAX_RUNTIME_SECONDS": "59"}, "invalid_env"),
        ({"MAX_RUNTIME_SECONDS": "20m"}, "invalid_env"),
        ({"MAX_RUNTIME_SECONDS": "-600"}, "invalid_env"),
        ({"HYPERPARAMS": "{not json"}, "invalid_hyperparams_json"),
        ({"HYPERPARAMS": "[1,2]"}, "invalid_hyperparams_json"),
    ],
)
def test_bad_environment_values_are_refused(changes, code):
    with pytest.raises(ConfigError) as caught:
        load_config(env(**changes))
    assert caught.value.code == code


def test_callback_needs_url_and_secret_together():
    cfg = load_config(env(CALLBACK_URL="https://api.example/cb", CALLBACK_SECRET="s3cr3t-value"))
    assert cfg.callback_url == "https://api.example/cb" and cfg.callback_secret == "s3cr3t-value"
    # A secret with no URL is not an error: there is nothing to sign.
    assert load_config(env(CALLBACK_SECRET="s3cr3t-value")).callback_secret is None


def test_secrets_cover_the_token_the_callback_secret_and_every_signed_query():
    cfg = load_config(
        env(HF_TOKEN="hf_exampletoken", CALLBACK_URL="https://api.example/cb", CALLBACK_SECRET="s3cr3t-value")
    )
    assert "hf_exampletoken" in cfg.secrets
    assert "s3cr3t-value" in cfg.secrets
    assert "X-Amz-Signature=abcdef0123456789" in cfg.secrets
    assert "X-Amz-Signature=1111222233334444" in cfg.secrets
    assert "X-Amz-Signature=5555666677778888" in cfg.secrets
    shown = repr(cfg)
    assert "hf_exampletoken" not in shown and "s3cr3t-value" not in shown
    assert "X-Amz-Signature" not in shown


@pytest.mark.parametrize(
    "key, good",
    [
        ("epochs", [1, 10]),
        ("batchSize", [1, 16]),
        ("gradientAccumulationSteps", [1, 32]),
        ("learningRate", [1e-6, 1e-3]),
        ("warmupRatio", [0, 0.2]),
        ("loraR", [4, 8, 16, 32, 64]),
        ("loraAlpha", [1, 128]),
        ("loraDropout", [0, 0.3]),
        ("maxSeqLength", [128, 4096]),
        ("maxSteps", [1, 20000, None]),
        ("evalSplit", [0, 0.2, None]),
        ("seed", [0, 2**31 - 1]),
        ("targetModules", ["all-linear", ["q_proj", "v_proj"]]),
    ],
)
def test_bounds_are_inclusive(key, good):
    for value in good:
        parsed = parse_hyperparams(json.dumps({key: value}))
        expected = tuple(value) if isinstance(value, list) else value
        assert getattr(parsed, key) == expected


@pytest.mark.parametrize(
    "key, bad",
    [
        ("epochs", [0, 11, 1.5, "3", True]),
        ("batchSize", [0, 17]),
        ("gradientAccumulationSteps", [0, 33]),
        ("learningRate", [0, 9e-7, 2e-3, "2e-4", float("nan")]),
        ("warmupRatio", [-0.01, 0.21]),
        ("loraR", [0, 12, 128, True, "16"]),
        ("loraAlpha", [0, 129]),
        ("loraDropout", [-0.1, 0.31]),
        ("maxSeqLength", [127, 4097]),
        ("maxSteps", [0, 20001]),
        ("evalSplit", [-0.1, 0.21]),
        ("seed", [-1, 2**31]),
        ("targetModules", ["all", [], ["Q_proj"], ["fc1"], ["a"] * 13, ["q_proj", "q_proj"], [1]]),
    ],
)
def test_out_of_bounds_values_are_refused(key, bad):
    for value in bad:
        with pytest.raises(ConfigError) as caught:
            # Python's json writes NaN bare, as a careless caller would.
            parse_hyperparams(json.dumps({key: value}))
        assert caught.value.code == "invalid_hyperparameter", (key, value)
        assert caught.value.details["field"] == key


def test_unknown_hyperparameters_are_refused_by_name():
    with pytest.raises(ConfigError) as caught:
        parse_hyperparams(json.dumps({"learning_rate": 1e-4, "gpuCount": 2}))
    assert caught.value.code == "unknown_hyperparameter"
    assert caught.value.details["fields"] == ["gpuCount", "learning_rate"]
