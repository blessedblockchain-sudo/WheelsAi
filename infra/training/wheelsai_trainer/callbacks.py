"""Signed callbacks to the API.

Each event is POSTed as JSON with

    X-WheelsAI-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>

where rawBody is the exact bytes sent. Delivery runs on its own thread and
never fails or slows a run: the user pays for GPU seconds, so a training
step must not wait on an API that is down.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import queue
import threading
import time
from typing import Callable

import requests

from . import TRAINER_VERSION

SIGNATURE_HEADER = "X-WheelsAI-Signature"
CALLBACK_ATTEMPTS = 3
CALLBACK_BACKOFF_SECONDS = (1.0, 3.0)
CALLBACK_TIMEOUT_SECONDS = 10.0
# Events waiting for delivery. When the API is unreachable for long, new
# step events are dropped rather than held: stdout already has them.
QUEUE_LIMIT = 256
# How long the process waits at exit for the terminal event to be delivered.
CLOSE_TIMEOUT_SECONDS = 45.0


def sign(secret: str, timestamp: int, raw_body: bytes) -> str:
    """The value of the signature header for one request."""
    signed = str(timestamp).encode("ascii") + b"." + raw_body
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def encode_body(event: dict, job_id: str) -> bytes:
    """The callback body: the event as printed, plus the job id."""
    body = dict(event)
    body["jobId"] = job_id
    return json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")


class CallbackSender:
    def __init__(
        self,
        url: str,
        secret: str,
        job_id: str,
        *,
        attempts: int | None = None,
        backoff_seconds: tuple | None = None,
        timeout_seconds: float | None = None,
        session: requests.Session | None = None,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._url = url
        self._secret = secret
        self._job_id = job_id
        self._attempts = max(1, CALLBACK_ATTEMPTS if attempts is None else attempts)
        self._backoff = CALLBACK_BACKOFF_SECONDS if backoff_seconds is None else backoff_seconds
        self._timeout = CALLBACK_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
        self._session = session or requests.Session()
        self._now = now
        self._sleep = sleep
        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_LIMIT)
        self._closing = threading.Event()
        self.delivered = 0
        self.failed = 0
        self.dropped = 0
        self._thread = threading.Thread(target=self._run, name="wheelsai-callbacks", daemon=True)
        self._thread.start()

    def send(self, event: dict) -> None:
        """Queue an event. Never blocks and never raises."""
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self.dropped += 1

    def close(self, timeout_seconds: float = CLOSE_TIMEOUT_SECONDS) -> None:
        """Deliver what is queued, within a deadline, then stop the thread."""
        self._closing.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        self._thread.join(timeout_seconds)

    def _run(self) -> None:
        while True:
            try:
                event = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._closing.is_set():
                    return
                continue
            if event is None:
                return
            if self._post(event):
                self.delivered += 1
            else:
                self.failed += 1

    def _post(self, event: dict) -> bool:
        raw_body = encode_body(event, self._job_id)
        for attempt in range(self._attempts):
            # Signed per attempt: the API refuses a timestamp more than
            # 300 seconds old, and a retry after a long timeout could be.
            timestamp = int(self._now())
            headers = {
                "Content-Type": "application/json",
                "User-Agent": f"wheelsai-trainer/{TRAINER_VERSION}",
                SIGNATURE_HEADER: sign(self._secret, timestamp, raw_body),
            }
            try:
                response = self._session.post(
                    self._url, data=raw_body, headers=headers, timeout=self._timeout
                )
                if response.status_code < 300:
                    return True
                # A 4xx is the API's answer (bad signature, stale seq, job
                # already final); sending the same bytes again cannot change
                # it. 429 and 5xx may pass.
                if response.status_code < 500 and response.status_code != 429:
                    return False
            except requests.RequestException:
                pass
            if attempt + 1 < self._attempts:
                self._sleep(self._backoff[min(attempt, len(self._backoff) - 1)])
        return False
