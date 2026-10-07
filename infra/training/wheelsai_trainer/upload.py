"""The three data transfers of a run: dataset in (GET), adapter tarball and
metrics.json out (PUT). All plain HTTP on signed URLs, so the container
holds no storage credential and works the same against S3, R2, MinIO or
the API's own transfer routes.
"""

from __future__ import annotations

import hashlib
import os
import tarfile
import time
from typing import Callable

import requests

from .errors import DatasetError, UploadError

TRANSFER_ATTEMPTS = 3
TRANSFER_BACKOFF_SECONDS = (2.0, 5.0)
CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 120.0
CHUNK_BYTES = 1024 * 1024

ADAPTER_CONTENT_TYPE = "application/gzip"
METRICS_CONTENT_TYPE = "application/json"

ADAPTER_ARCHIVE_NAME = "adapter.tar.gz"
# The two files vLLM --lora-modules needs, and our manifest. Anything else
# in the adapter directory is left out of the archive.
ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors", "wheelsai_manifest.json")


def _retryable(status: int) -> bool:
    return status >= 500 or status in (408, 429)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_dataset(
    url: str,
    dest_path: str,
    expected_sha256: str | None = None,
    *,
    session: requests.Session | None = None,
    sleep: Callable[[float], None] = time.sleep,
    backoff_seconds: tuple | None = None,
) -> dict:
    """Stream the dataset to disk. Returns {bytes, sha256}.

    A 4xx is final (the URL is wrong, expired or not ours to read); a 5xx,
    a timeout or a dropped connection is retried. Every failure is exit 11
    with a `code` and the HTTP status, so the API can tell an expired URL
    from a storage outage when it decides who pays.
    """
    session = session or requests.Session()
    backoff_seconds = TRANSFER_BACKOFF_SECONDS if backoff_seconds is None else backoff_seconds
    last_error = "no attempt made"
    status: int | None = None
    for attempt in range(TRANSFER_ATTEMPTS):
        status = None
        try:
            with session.get(
                url, stream=True, timeout=(CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS)
            ) as response:
                status = response.status_code
                if status >= 400:
                    last_error = f"HTTP {status}"
                    if not _retryable(status):
                        break
                else:
                    digest = hashlib.sha256()
                    size = 0
                    with open(dest_path, "wb") as handle:
                        for chunk in response.iter_content(CHUNK_BYTES):
                            handle.write(chunk)
                            digest.update(chunk)
                            size += len(chunk)
                    actual = digest.hexdigest()
                    if expected_sha256 and actual != expected_sha256:
                        raise DatasetError(
                            "The downloaded dataset does not match DATASET_SHA256",
                            code="dataset_checksum_mismatch",
                            bytes=size,
                        )
                    return {"bytes": size, "sha256": actual}
        except requests.RequestException as error:
            last_error = type(error).__name__
        if attempt + 1 < TRANSFER_ATTEMPTS:
            sleep(backoff_seconds[min(attempt, len(backoff_seconds) - 1)])
    details = {"httpStatus": status} if status is not None else {}
    raise DatasetError(
        f"Could not download the dataset: {last_error}", code="dataset_download_failed", **details
    )


def pack_adapter(adapter_dir: str, archive_path: str) -> dict:
    """Write adapter.tar.gz with the adapter files at the archive root.

    Root-level members mean the serving side can extract straight into the
    directory it hands to vLLM. Returns {bytes, sha256, files}.
    """
    members = []
    for name in ADAPTER_FILES:
        path = os.path.join(adapter_dir, name)
        if not os.path.isfile(path):
            raise UploadError(f"The adapter is missing {name}", code="adapter_incomplete")
        members.append((name, path))
    with tarfile.open(archive_path, "w:gz") as archive:
        for name, path in members:
            info = archive.gettarinfo(path, arcname=name)
            # No uid, user name or mode of the build host in the artifact.
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mode = 0o644
            with open(path, "rb") as handle:
                archive.addfile(info, handle)
    return {
        "bytes": os.path.getsize(archive_path),
        "sha256": sha256_file(archive_path),
        "files": [name for name, _ in members],
    }


def put_file(
    url: str,
    path: str,
    content_type: str,
    *,
    what: str,
    session: requests.Session | None = None,
    sleep: Callable[[float], None] = time.sleep,
    backoff_seconds: tuple | None = None,
) -> None:
    """PUT a file with an exact Content-Length (a presigned S3 PUT refuses
    chunked bodies). Raises UploadError (exit 20) when every attempt fails."""
    session = session or requests.Session()
    backoff_seconds = TRANSFER_BACKOFF_SECONDS if backoff_seconds is None else backoff_seconds
    size = os.path.getsize(path)
    last_error = "no attempt made"
    status: int | None = None
    for attempt in range(TRANSFER_ATTEMPTS):
        status = None
        try:
            with open(path, "rb") as handle:
                response = session.put(
                    url,
                    data=handle,
                    headers={"Content-Type": content_type, "Content-Length": str(size)},
                    timeout=(CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS),
                )
            status = response.status_code
            if status < 300:
                return
            last_error = f"HTTP {status}"
            if not _retryable(status):
                break
        except requests.RequestException as error:
            last_error = type(error).__name__
        if attempt + 1 < TRANSFER_ATTEMPTS:
            sleep(backoff_seconds[min(attempt, len(backoff_seconds) - 1)])
    details = {"httpStatus": status} if status is not None else {}
    raise UploadError(
        f"Could not upload the {what}: {last_error}", code=f"{what}_upload_failed", **details
    )
