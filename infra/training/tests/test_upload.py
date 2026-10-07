"""Dataset download, adapter archive and artifact upload."""

from __future__ import annotations

import hashlib
import io
import tarfile

import pytest

from wheelsai_trainer.errors import EXIT_DATASET, EXIT_UPLOAD, DatasetError, UploadError
from wheelsai_trainer.upload import download_dataset, pack_adapter, put_file, sha256_file


def test_download_streams_to_disk_and_reports_size_and_digest(storage, tmp_path):
    body = b'{"text": "a"}\n' * 5000
    storage.objects["/dataset"] = body
    dest = tmp_path / "data.jsonl"
    result = download_dataset(storage.url("/dataset", "sig=abc"), str(dest), hashlib.sha256(body).hexdigest())
    assert dest.read_bytes() == body
    assert result == {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}


def test_download_checksum_mismatch_is_a_dataset_error(storage, tmp_path):
    storage.objects["/dataset"] = b"changed after validation"
    with pytest.raises(DatasetError) as caught:
        download_dataset(storage.url("/dataset"), str(tmp_path / "d"), "0" * 64)
    assert caught.value.exit_code == EXIT_DATASET
    assert caught.value.code == "dataset_checksum_mismatch"
    assert storage.count("GET", "/dataset") == 1, "a wrong digest is not retried"


def test_download_404_is_final_and_carries_the_status(storage, tmp_path):
    with pytest.raises(DatasetError) as caught:
        download_dataset(storage.url("/dataset"), str(tmp_path / "d"))
    assert caught.value.code == "dataset_download_failed"
    assert caught.value.details == {"httpStatus": 404}
    assert storage.count("GET", "/dataset") == 1


def test_download_403_of_an_expired_url_is_final(storage, tmp_path):
    storage.status["/dataset"] = 403
    with pytest.raises(DatasetError) as caught:
        download_dataset(storage.url("/dataset"), str(tmp_path / "d"))
    assert caught.value.details == {"httpStatus": 403}
    assert storage.count("GET", "/dataset") == 1


def test_download_retries_a_5xx_and_then_succeeds(storage, tmp_path):
    storage.objects["/dataset"] = b"rows"
    storage.status_sequence["/dataset"] = [503, 500]
    assert download_dataset(storage.url("/dataset"), str(tmp_path / "d"))["bytes"] == 4
    assert storage.count("GET", "/dataset") == 3


def test_download_gives_up_after_three_5xx(storage, tmp_path):
    storage.status["/dataset"] = 503
    with pytest.raises(DatasetError) as caught:
        download_dataset(storage.url("/dataset"), str(tmp_path / "d"))
    assert caught.value.details == {"httpStatus": 503}
    assert storage.count("GET", "/dataset") == 3


def test_download_from_a_dead_host_is_a_dataset_error_without_a_status(tmp_path):
    with pytest.raises(DatasetError) as caught:
        download_dataset("http://127.0.0.1:9/dataset", str(tmp_path / "d"))
    assert caught.value.code == "dataset_download_failed" and caught.value.details == {}


def make_adapter_dir(tmp_path):
    directory = tmp_path / "adapter"
    directory.mkdir()
    (directory / "adapter_config.json").write_text('{"r": 8}', encoding="utf-8")
    (directory / "adapter_model.safetensors").write_bytes(b"\x00" * 2048)
    (directory / "wheelsai_manifest.json").write_text('{"schema": 1}', encoding="utf-8")
    (directory / "README.md").write_text("not ours", encoding="utf-8")
    return directory


def test_archive_holds_exactly_the_adapter_files_at_its_root(tmp_path):
    directory = make_adapter_dir(tmp_path)
    archive = tmp_path / "adapter.tar.gz"
    packed = pack_adapter(str(directory), str(archive))
    assert packed["files"] == ["adapter_config.json", "adapter_model.safetensors", "wheelsai_manifest.json"]
    assert packed["bytes"] == archive.stat().st_size
    assert packed["sha256"] == sha256_file(str(archive)) == hashlib.sha256(archive.read_bytes()).hexdigest()
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        assert [m.name for m in members] == packed["files"]
        assert all(m.isfile() and m.uid == 0 and m.uname == "" and m.mode == 0o644 for m in members)
        assert tar.extractfile("adapter_model.safetensors").read() == b"\x00" * 2048


def test_archive_refuses_an_incomplete_adapter(tmp_path):
    directory = make_adapter_dir(tmp_path)
    (directory / "adapter_model.safetensors").unlink()
    with pytest.raises(UploadError) as caught:
        pack_adapter(str(directory), str(tmp_path / "a.tar.gz"))
    assert caught.value.code == "adapter_incomplete"


def test_put_sends_the_bytes_with_length_and_content_type(storage, tmp_path):
    path = tmp_path / "metrics.json"
    path.write_bytes(b'{"schema":1}')
    put_file(storage.url("/metrics", "sig=abc"), str(path), "application/json", what="metrics")
    upload = storage.uploads["/metrics"]
    assert upload["body"] == b'{"schema":1}'
    assert upload["headers"]["Content-Type"] == "application/json"
    assert upload["headers"]["Content-Length"] == "12"
    # A presigned S3 PUT refuses a chunked body.
    assert "Transfer-Encoding" not in upload["headers"]


def test_put_retries_a_5xx_with_the_whole_body_each_time(storage, tmp_path):
    path = tmp_path / "adapter.tar.gz"
    path.write_bytes(io.BytesIO(b"x" * 70000).getvalue())
    storage.status_sequence["/adapter"] = [500, 503]
    put_file(storage.url("/adapter"), str(path), "application/gzip", what="adapter")
    assert storage.count("PUT", "/adapter") == 3
    assert len(storage.uploads["/adapter"]["body"]) == 70000


def test_put_failure_is_an_upload_error_naming_what_failed(storage, tmp_path):
    path = tmp_path / "adapter.tar.gz"
    path.write_bytes(b"x")
    storage.status["/adapter"] = 500
    with pytest.raises(UploadError) as caught:
        put_file(storage.url("/adapter"), str(path), "application/gzip", what="adapter")
    assert caught.value.exit_code == EXIT_UPLOAD
    assert caught.value.code == "adapter_upload_failed"
    assert caught.value.details == {"httpStatus": 500}
    assert storage.count("PUT", "/adapter") == 3


def test_put_403_is_not_retried(storage, tmp_path):
    path = tmp_path / "metrics.json"
    path.write_bytes(b"{}")
    storage.status["/metrics"] = 403
    with pytest.raises(UploadError) as caught:
        put_file(storage.url("/metrics"), str(path), "application/json", what="metrics")
    assert caught.value.code == "metrics_upload_failed"
    assert storage.count("PUT", "/metrics") == 1
