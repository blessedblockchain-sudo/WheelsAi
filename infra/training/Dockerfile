# WheelsAI training image: LoRA and QLoRA fine-tuning of a causal language
# model, driven by environment variables. Contract: README.md in this folder.
#
# Build context is THIS directory (infra/training), not the repository root:
#   docker build -t wheelsai-trainer infra/training
#
# It needs BuildKit (the default builder since Docker 23) for the cache
# mounts and the here-documents below. No "# syntax=" line: that one makes
# every build fetch a frontend image first, and nothing here needs a newer
# frontend than the builder's own.
#
# The base carries torch 2.4.1 with the CUDA 12.1 runtime and cuDNN 9, so no
# compiler and no CUDA toolkit are installed here. It is pinned by digest as
# well as by tag: a job that is paid for must not change under a moved tag.
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime@sha256:ac7c098a81512e719afa5d2d497f812d7db3498f340a4b819c69cb7b3b257126

LABEL org.opencontainers.image.title="wheelsai-trainer" \
      org.opencontainers.image.description="LoRA / QLoRA fine-tuning job for WheelsAI" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/workspace/hf \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_PROGRESS_BARS=1 \
    TOKENIZERS_PARALLELISM=false

# Dependencies before the code, so a change to train.py does not reinstall
# them. torch comes from the base image and is deliberately not in either
# file.
#
# They go in as four layers, not one. A registry takes a layer as a single
# upload and starts it again from nothing when the connection drops, and one
# layer of 240 MB could not be published over a link that drops every few
# minutes. The two requirement files stay the only place a version is
# written: each step installs under requirements.txt as constraints, and the
# check after the last step fails the build if a pin of either file is not
# installed. The pip cache is a build cache mount: the builder keeps the
# wheels for the next build and they never enter a layer.
COPY requirements.txt requirements-gpu.txt /app/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --cache-dir /root/.cache/pip -c /app/requirements.txt numpy
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --cache-dir /root/.cache/pip -c /app/requirements.txt pyarrow
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --cache-dir /root/.cache/pip -r /app/requirements.txt

# bitsandbytes ships one compiled library for each CUDA release, 16 of them
# at about 25 MB each, and loads the one named after torch's CUDA version
# (get_cuda_bnb_library_path in bitsandbytes/cextension.py). That one, its
# variant for cards older than compute capability 7.5 and the CPU stub are
# kept; the other 14 can never be loaded here and are 340 MB of every pull.
RUN --mount=type=cache,target=/root/.cache/pip <<'EOF'
set -eu
pip install --cache-dir /root/.cache/pip -c /app/requirements.txt -r /app/requirements-gpu.txt
keep="libbitsandbytes_cuda$(python -c "import torch; print(torch.version.cuda.replace('.', ''))")"
folder="$(python -c "from importlib.util import find_spec; print(find_spec('bitsandbytes').submodule_search_locations[0])")"
cd "$folder"
for library in libbitsandbytes_cuda*.so; do
  case "$library" in
    "$keep.so" | "${keep}_nocublaslt.so") ;;
    *) rm "$library" ;;
  esac
done
EOF

# What the image must hold, checked with no network: every pin of both files
# is installed, torch is still the base's CUDA build, each library imports
# against it, and the bitsandbytes library a GPU job loads is there and
# links against the CUDA libraries of this image (peft imports bitsandbytes
# in every run, LoRA included). HF_HOME points away for the check: importing
# transformers creates its cache folder, and a root-owned one under
# /workspace locks the job's user out of its own model cache.
RUN <<'EOF'
set -eu
pip install --no-index -r /app/requirements.txt -r /app/requirements-gpu.txt
HF_HOME=/tmp/hf-build-check python - <<'PY'
import ctypes
from importlib.metadata import version
from importlib.util import find_spec
from pathlib import Path

import accelerate, peft, pyarrow, requests, safetensors, torch, transformers

assert torch.__version__.startswith("2.4.1"), torch.__version__
assert torch.version.cuda, "the CUDA build of torch was replaced"
folder = Path(find_spec("bitsandbytes").submodule_search_locations[0])
cuda = "cuda" + torch.version.cuda.replace(".", "")
assert (folder / "libbitsandbytes_cpu.so").is_file(), "bitsandbytes has no CPU library"
for name in (f"libbitsandbytes_{cuda}.so", f"libbitsandbytes_{cuda}_nocublaslt.so"):
    # Loading it resolves its CUDA libraries; no GPU is needed for that.
    assert hasattr(ctypes.CDLL(str(folder / name)), "get_context"), f"{name} is not the CUDA build"
print(
    "torch", torch.__version__, "cuda", torch.version.cuda,
    "transformers", transformers.__version__, "peft", peft.__version__,
    "bitsandbytes", version("bitsandbytes"),
)
PY
rm -rf /tmp/hf-build-check
EOF

COPY train.py /app/train.py
COPY wheelsai_trainer /app/wheelsai_trainer

# Not root: the job reads user data and a model from the internet, and has
# no reason to own the container. /workspace holds the dataset, the model
# cache (HF_HOME), checkpoints and the adapter; it is gone with the node.
#
# /workspace is removed before it is made, whatever an earlier step left
# there. Importing transformers as root with HF_HOME set is enough to leave
# a root-owned hf/hub folder, and with that in place the job's user cannot
# create its model cache: every job then fails at the model download.
RUN groupadd --gid 10001 trainer \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin trainer \
 && rm -rf /workspace \
 && mkdir -p /workspace \
 && chown trainer:trainer /workspace
USER 10001:10001
WORKDIR /workspace

# As the job's user, the two places a job writes: the model cache and the
# work directory. A folder it cannot write fails the build here, not a job
# on a rented GPU.
RUN python -c "import os, tempfile; \
hub = os.path.join(os.environ['HF_HOME'], 'hub'); \
os.makedirs(hub, exist_ok=True); \
tempfile.TemporaryDirectory(dir=hub).cleanup(); \
tempfile.TemporaryDirectory(dir='/workspace').cleanup(); \
print('uid', os.getuid(), 'writes', hub, 'and /workspace')"

# No secrets are baked in. HF_TOKEN, the callback secret and the signed URLs
# arrive in the job definition's env at run time.
#
# The image insists on a GPU. Left to choose, train.py falls back to the
# processor when no GPU is visible, and a node sold as a GPU that shows none
# would then train for the whole run and the run would be charged. With
# --device cuda it ends in seconds with exit 10, cuda_unavailable, which is
# charged to nobody. A later --device on the command line wins (the CPU
# proof passes --device cpu).
ENTRYPOINT ["python", "/app/train.py", "--device", "cuda"]
