"""WHEELSAI_EVENT lines, redaction, and the signed callback transport."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import time

import pytest

from wheelsai_trainer.callbacks import SIGNATURE_HEADER, CallbackSender, encode_body, sign
from wheelsai_trainer.events import EVENT_PREFIX, EventEmitter, parse_event_line, redact

SECRET = "unit-test-secret"


def parse_signature(header: str) -> tuple:
    parts = dict(part.split("=", 1) for part in header.split(","))
    return int(parts["t"]), parts["v1"]


def verify(secret: str, header: str, raw: bytes) -> bool:
    """The check the API will run, written independently of sign()."""
    timestamp, digest = parse_signature(header)
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, digest)


def test_events_are_one_prefixed_json_line_each_with_rising_seq():
    stream = io.StringIO()
    emitter = EventEmitter(stream=stream)
    emitter.emit("started", gpu=None, vramGb=None)
    emitter.phase("train")
    emitter.emit("completed", finalTrainLoss=0.5, finalEvalLoss=None, trainSeconds=1.0)
    lines = stream.getvalue().splitlines()
    assert len(lines) == 3 and all(line.startswith(EVENT_PREFIX) for line in lines)
    events = [parse_event_line(line) for line in lines]
    assert [e["seq"] for e in events] == [1, 2, 3]
    assert [e["type"] for e in events] == ["started", "phase", "completed"]
    assert all(e["v"] == 1 and e["ts"].endswith("Z") for e in events)
    assert events[1]["phase"] == "train"


def test_unknown_types_and_phases_are_programming_errors():
    emitter = EventEmitter(stream=io.StringIO())
    with pytest.raises(ValueError):
        emitter.emit("progress")
    with pytest.raises(ValueError):
        emitter.phase("warmup")


def test_nan_cannot_be_emitted():
    with pytest.raises(ValueError):
        EventEmitter(stream=io.StringIO()).emit("eval", step=1, evalLoss=float("nan"))


def test_step_events_are_throttled_but_the_forced_last_one_is_not():
    now = [0.0]
    stream = io.StringIO()
    emitter = EventEmitter(stream=stream, step_interval_seconds=10.0, clock=lambda: now[0])
    assert emitter.step(step=1) is not None
    now[0] = 9.9
    assert emitter.step(step=2) is None
    now[0] = 10.0
    assert emitter.step(step=3) is not None
    now[0] = 10.1
    assert emitter.step(step=4) is None
    assert emitter.step(force=True, step=5) is not None
    steps = [parse_event_line(line)["step"] for line in stream.getvalue().splitlines()]
    assert steps == [1, 3, 5]


def test_failed_event_is_redacted_clipped_and_names_the_phase():
    stream = io.StringIO()
    emitter = EventEmitter(secrets=("sig=verysecretvalue",), stream=stream)
    emitter.phase("upload")
    emitter.failed(20, "adapter_upload_failed", "PUT https://b.example/a?sig=verysecretvalue " + "x" * 2000)
    event = parse_event_line(stream.getvalue().splitlines()[-1])
    assert event["exitCode"] == 20 and event["code"] == "adapter_upload_failed"
    assert event["phase"] == "upload"
    assert "verysecretvalue" not in stream.getvalue()
    assert len(event["message"]) <= 500


def test_redact_and_parse_helpers():
    assert redact("a token=abc b", ["token=abc"]) == "a [redacted] b"
    assert parse_event_line("plain log line") is None
    assert parse_event_line(EVENT_PREFIX + "{not json") is None
    assert parse_event_line(EVENT_PREFIX + '{"type":"mystery"}') is None


def test_signature_is_hmac_sha256_over_timestamp_dot_raw_body():
    raw = b'{"v":1,"seq":1,"type":"started","jobId":"job_1"}'
    header = sign(SECRET, 1790000000, raw)
    expected = hmac.new(SECRET.encode(), b"1790000000." + raw, hashlib.sha256).hexdigest()
    assert header == f"t=1790000000,v1={expected}"
    assert verify(SECRET, header, raw)
    assert not verify("another-secret", header, raw)
    assert not verify(SECRET, header, raw + b" ")


def test_callback_body_is_the_event_plus_the_job_id():
    event = {"v": 1, "seq": 4, "ts": "2026-10-07T00:00:00.000Z", "type": "phase", "phase": "train"}
    assert json.loads(encode_body(event, "job_9")) == {**event, "jobId": "job_9"}


def test_sender_delivers_signed_events_in_order(storage):
    sender = CallbackSender(storage.url("/callback"), SECRET, "job_1")
    emitter = EventEmitter(stream=io.StringIO(), sink=sender.send)
    emitter.emit("started", gpu=None, vramGb=None)
    emitter.phase("load_model")
    emitter.emit("uploaded", adapterBytes=10, adapterSha256="ab")
    sender.close(10)
    assert [e["seq"] for e in storage.callback_events()] == [1, 2, 3]
    assert all(e["jobId"] == "job_1" for e in storage.callback_events())
    for entry in storage.callbacks:
        assert entry["headers"]["Content-Type"] == "application/json"
        header = entry["headers"][SIGNATURE_HEADER]
        assert verify(SECRET, header, entry["raw"])
        assert abs(parse_signature(header)[0] - time.time()) < 60
    assert (sender.delivered, sender.failed) == (3, 0)


def test_sender_retries_a_5xx_three_times_then_gives_up_quietly(storage):
    storage.status["/callback"] = 503
    sender = CallbackSender(storage.url("/callback"), SECRET, "job_1")
    sender.send({"v": 1, "seq": 1, "type": "started"})
    sender.close(10)
    assert storage.count("POST", "/callback") == 3
    assert (sender.delivered, sender.failed) == (0, 1)


def test_sender_recovers_when_a_retry_succeeds(storage):
    storage.status_sequence["/callback"] = [500, 502]
    sender = CallbackSender(storage.url("/callback"), SECRET, "job_1")
    sender.send({"v": 1, "seq": 1, "type": "started"})
    sender.close(10)
    assert storage.count("POST", "/callback") == 3
    assert (sender.delivered, sender.failed) == (1, 0)


def test_sender_does_not_repeat_a_4xx(storage):
    storage.status["/callback"] = 401
    sender = CallbackSender(storage.url("/callback"), SECRET, "job_1")
    sender.send({"v": 1, "seq": 1, "type": "started"})
    sender.close(10)
    assert storage.count("POST", "/callback") == 1
    assert sender.failed == 1


def test_sender_survives_an_endpoint_that_is_not_there():
    # Port 9 on loopback: nothing listens, the connection is refused.
    sender = CallbackSender("http://127.0.0.1:9/callback", SECRET, "job_1")
    sender.send({"v": 1, "seq": 1, "type": "started"})
    sender.close(10)
    assert (sender.delivered, sender.failed) == (0, 1)


def test_send_never_blocks_when_the_queue_is_full(storage, monkeypatch):
    from wheelsai_trainer import callbacks

    monkeypatch.setattr(callbacks, "QUEUE_LIMIT", 2)
    sender = CallbackSender("http://127.0.0.1:9/callback", SECRET, "job_1", timeout_seconds=0.2)
    started = time.monotonic()
    for seq in range(50):
        sender.send({"v": 1, "seq": seq, "type": "step"})
    assert time.monotonic() - started < 1.0
    assert sender.dropped > 0
    sender.close(5)
