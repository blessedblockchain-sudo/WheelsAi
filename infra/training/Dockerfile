# syntax=docker/dockerfile:1.7
#
# WheelsAI training image: LoRA and QLoRA fine-tuning of a causal language
# model, driven by environment variables. Contract: README.md in this folder.
#
# Build context is THIS directory (infra/training), not the repository root:
#   docker build -t wheelsai-trainer infra/training
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
# file; the check below fails the build if pip replaced it or if a pin does
# not import against it.
COPY requirements.txt requirements-gpu.txt /app/
RUN pip install -r /app/requirements.txt -r /app/requirements-gpu.txt \
 && python -c "import torch, transformers, peft, accelerate, safetensors, pyarrow, requests; \
assert torch.__version__.startswith('2.4.1'), torch.__version__; \
assert torch.version.cuda, 'the CUDA build of torch was replaced'; \
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'transformers', transformers.__version__, 'peft', peft.__version__)" \
 && pip show bitsandbytes | head -n 2

COPY train.py /app/train.py
COPY wheelsai_trainer /app/wheelsai_trainer

# Not root: the job reads user data and a model from the internet, and has
# no reason to own the container. /workspace holds the dataset, the model
# cache (HF_HOME), checkpoints and the adapter; it is gone with the node.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin trainer \
 && mkdir -p /workspace \
 && chown trainer:trainer /workspace
USER 10001:10001
WORKDIR /workspace

# No secrets are baked in. HF_TOKEN, the callback secret and the signed URLs
# arrive in the job definition's env at run time.
ENTRYPOINT ["python", "/app/train.py"]
