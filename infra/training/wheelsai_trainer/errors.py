"""Exit codes and the exceptions that carry them.

The process exit code is the one fact Nosana keeps about a finished job, so
every failure the trainer can name maps to exactly one code here. `code` is
a finer, stable machine string inside the same exit code; it travels in the
`failed` event so the API can tell, say, a 404 on the dataset URL from an
empty file without parsing the message.
"""

from __future__ import annotations

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_CONFIG = 10
EXIT_DATASET = 11
EXIT_BASE_MODEL = 12
EXIT_OUT_OF_MEMORY = 13
EXIT_DIVERGED = 14
EXIT_UPLOAD = 20
EXIT_INTERRUPTED = 30

# Longest message put in an event. The API refuses callback bodies over
# 64 KB; a library traceback pasted whole would get there.
MAX_MESSAGE_CHARS = 500


class TrainerError(Exception):
    """A failure with a known exit code."""

    exit_code = EXIT_UNEXPECTED
    default_code = "unexpected"

    def __init__(self, message: str, code: str | None = None, **details):
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code
        # Extra JSON-safe facts for the failed event (row number, HTTP status).
        self.details = details


class ConfigError(TrainerError):
    exit_code = EXIT_CONFIG
    default_code = "invalid_config"


class DatasetError(TrainerError):
    exit_code = EXIT_DATASET
    default_code = "dataset_error"


class BaseModelError(TrainerError):
    exit_code = EXIT_BASE_MODEL
    default_code = "base_model_error"


class OutOfMemoryError(TrainerError):
    exit_code = EXIT_OUT_OF_MEMORY
    default_code = "gpu_out_of_memory"


class DivergedError(TrainerError):
    exit_code = EXIT_DIVERGED
    default_code = "loss_not_finite"


class UploadError(TrainerError):
    exit_code = EXIT_UPLOAD
    default_code = "upload_failed"


class Interrupted(BaseException):
    """Raised in the main thread by the SIGTERM / SIGINT handler.

    A BaseException so that a library's `except Exception` between two
    training steps cannot swallow the stop request.
    """

    def __init__(self, signal_name: str = "SIGTERM"):
        super().__init__(signal_name)
        self.signal_name = signal_name
