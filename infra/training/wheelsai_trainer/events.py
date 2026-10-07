"""Progress events: one JSON line on stdout per event, and the same object
to the signed callback.

The stdout line is the record. Nosana keeps a finished job's logs, so the
API can rebuild a run from them when every callback was lost; the callback
only makes the same facts arrive while the run is still going.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Iterable, TextIO

from . import EVENT_SCHEMA_VERSION
from .errors import MAX_MESSAGE_CHARS

EVENT_PREFIX = "WHEELSAI_EVENT "

EVENT_TYPES = ("started", "phase", "step", "eval", "uploaded", "completed", "failed")
PHASES = ("download_dataset", "load_model", "tokenize", "train", "upload")

# At most one `step` event in this many seconds. The last step of a run is
# always emitted, whatever the clock says.
STEP_EVENT_INTERVAL_SECONDS = 10.0

REDACTED = "[redacted]"


def redact(text: str, secrets: Iterable[str]) -> str:
    """Remove every secret from a string bound for stdout or a callback.

    Library errors quote the URL they failed on, and a signed URL's query
    string is a credential, so messages are scrubbed rather than trusted.
    """
    for secret in secrets:
        if secret:
            text = text.replace(secret, REDACTED)
    return text


def clip(text: str) -> str:
    text = " ".join(str(text).split())
    if len(text) > MAX_MESSAGE_CHARS:
        return text[: MAX_MESSAGE_CHARS - 3] + "..."
    return text


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EventEmitter:
    """Numbers, prints and forwards events.

    `seq` starts at 1 and rises by one per event; the API accepts a callback
    only when its seq is greater than the last one stored, so a retried or
    reordered delivery cannot move a job backwards.
    """

    def __init__(
        self,
        secrets: Iterable[str] = (),
        stream: TextIO | None = None,
        sink: Callable[[dict], None] | None = None,
        step_interval_seconds: float = STEP_EVENT_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._secrets = tuple(secrets)
        self._stream = stream
        self._sink = sink
        self._step_interval = step_interval_seconds
        self._clock = clock
        self._seq = 0
        self._last_step_at: float | None = None
        # The phase the run is in, reported with a failure so the API knows
        # whether a stop came before, during or after training.
        self.current_phase: str | None = None
        # The signal handler's failed event and the training loop's step
        # event must not interleave half-written lines.
        self._lock = threading.Lock()

    def set_secrets(self, secrets: Iterable[str]) -> None:
        self._secrets = tuple(secrets)

    def set_sink(self, sink: Callable[[dict], None] | None) -> None:
        self._sink = sink

    def emit(self, event_type: str, **fields) -> dict:
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unknown event type: {event_type}")
        with self._lock:
            self._seq += 1
            event = {"v": EVENT_SCHEMA_VERSION, "seq": self._seq, "ts": _utc_now(), "type": event_type}
            event.update(fields)
            # allow_nan=False: NaN is not JSON, and JSON.parse on the API
            # side would reject the whole line. Callers pass null instead.
            line = json.dumps(event, separators=(",", ":"), allow_nan=False)
            line = redact(line, self._secrets)
            stream = self._stream or sys.stdout
            stream.write(EVENT_PREFIX + line + "\n")
            stream.flush()
            # Forward what was printed, so a redaction applies to both.
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # A secret that spanned JSON syntax: keep the line, send nothing.
                return event
        if self._sink is not None:
            try:
                self._sink(event)
            except Exception:
                # Delivery never fails a run; the line above is the record.
                pass
        return event

    def phase(self, phase: str) -> dict:
        if phase not in PHASES:
            raise ValueError(f"unknown phase: {phase}")
        self.current_phase = phase
        return self.emit("phase", phase=phase)

    def step(self, *, force: bool = False, **fields) -> dict | None:
        """Emit a step event unless one went out in the last interval."""
        now = self._clock()
        if (
            not force
            and self._last_step_at is not None
            and now - self._last_step_at < self._step_interval
        ):
            return None
        self._last_step_at = now
        return self.emit("step", **fields)

    def failed(self, exit_code: int, code: str, message: str, **details) -> dict:
        return self.emit(
            "failed",
            exitCode=exit_code,
            code=code,
            message=clip(redact(message, self._secrets)),
            phase=self.current_phase,
            **details,
        )


def parse_event_line(line: str) -> dict | None:
    """The inverse of emit, for tests and for reading a run's log back."""
    if not line.startswith(EVENT_PREFIX):
        return None
    try:
        event = json.loads(line[len(EVENT_PREFIX) :])
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") not in EVENT_TYPES:
        return None
    return event
