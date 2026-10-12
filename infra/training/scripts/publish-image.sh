#!/usr/bin/env bash
# Builds the training image from this folder and, when asked, publishes it and
# prints the value the API's TRAINING_IMAGE setting takes.
#
#   bash infra/training/scripts/publish-image.sh <repository>           build only
#   bash infra/training/scripts/publish-image.sh <repository> --push    build, publish, print the digest
#
# <repository> is where a GPU node pulls from WITHOUT a password, written with
# its registry host: docker.io/<account>/wheelsai-trainer. Log in to the
# registry first (docker login). This script never reads or prints a
# credential.
#
# It is the by-hand form of the trainer-image job in .gitlab-ci.yml: the same
# build and the same last line, TRAINING_IMAGE=<repository>@sha256:<digest>.
# The tag is the short commit. The API takes the digest form and no other: a
# tag can be moved, and a job that is paid for must not change under one.
#
# What it refuses:
#   - a repository without its registry host, or one the API would not accept;
#   - files that go into the image with changes that are not committed
#     (Dockerfile, .dockerignore, the two requirement files, train.py,
#     wheelsai_trainer/): the image a paid job runs must match a commit.
#     --allow-uncommitted lifts this for a build, never for --push.
#
# DATA. The first build downloads the base image (3.1 GB) and the Python
# packages; later builds reuse both. --push uploads only what the registry
# does not hold. Watch its first lines: "Mounted from" and "Layer already
# exists" cost nothing, "Pushing" is an upload.
#
# After --push it asks the registry for the manifest it just published, with
# no credential. "A node can pull it" is printed only when the registry
# served it. A registry that answers and refuses is an error; a connection
# that drops during the question is not, and the last line is still printed
# with "Not checked" above it. For a registry other than Docker Hub the check
# is left to you.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(dirname "$HERE")"

usage() {
  echo "usage: $0 <registry host>/<account>/<name> [--push] [--allow-uncommitted]" >&2
  echo "       for example: $0 docker.io/<account>/wheelsai-trainer --push" >&2
  exit 2
}

REPOSITORY=""
PUSH=0
ALLOW_UNCOMMITTED=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --allow-uncommitted) ALLOW_UNCOMMITTED=1 ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *)
      [ -z "$REPOSITORY" ] || { echo "one repository only" >&2; usage; }
      REPOSITORY="$arg"
      ;;
  esac
done
[ -n "$REPOSITORY" ] || usage

# The part of TRAINING_IMAGE_PATTERN (apps/api/src/config/training.ts) before
# the digest, without a tag: this script adds the tag itself.
if ! [[ "$REPOSITORY" =~ ^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]{1,5})?(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)+$ ]]; then
  echo "'$REPOSITORY' is not a repository the API would accept: lower case, <registry host>/<path>, no tag." >&2
  exit 2
fi
REGISTRY_HOST="${REPOSITORY%%/*}"
if [[ "$REGISTRY_HOST" != *.* && "$REGISTRY_HOST" != *:* ]]; then
  echo "Name the registry host, so a node never has to guess it: docker.io/$REPOSITORY" >&2
  exit 2
fi

REPO_ROOT="$(git -C "$TRAINING_DIR" rev-parse --show-toplevel)"
INPUTS=(Dockerfile .dockerignore requirements.txt requirements-gpu.txt train.py wheelsai_trainer)
UNCOMMITTED="$(git -C "$TRAINING_DIR" status --porcelain -- "${INPUTS[@]}")"
REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if [ -n "$UNCOMMITTED" ]; then
  if [ "$PUSH" = 1 ] || [ "$ALLOW_UNCOMMITTED" = 0 ]; then
    echo "These files go into the image and have changes that are not committed:" >&2
    echo "$UNCOMMITTED" >&2
    echo "Commit them first. (--allow-uncommitted builds anyway; it never publishes.)" >&2
    exit 1
  fi
  TAG="$TAG-uncommitted"
fi

command -v docker > /dev/null || { echo "docker is not installed" >&2; exit 1; }

echo "Building $REPOSITORY:$TAG from $TRAINING_DIR"
docker build --pull \
  --label "org.opencontainers.image.revision=$REVISION" \
  --tag "$REPOSITORY:$TAG" "$TRAINING_DIR"

BYTES="$(docker image inspect --format '{{.Size}}' "$REPOSITORY:$TAG")"
echo "Built $REPOSITORY:$TAG: $(awk -v b="$BYTES" 'BEGIN { printf "%.2f GB", b / 1e9 }') on disk."

if [ "$PUSH" = 0 ]; then
  echo "Not published. To try it on this machine, as a node would start it:"
  echo "  python infra/training/scripts/cpu_proof.py --image $REPOSITORY:$TAG"
  exit 0
fi

docker push "$REPOSITORY:$TAG"

# Docker lists Docker Hub repositories without their host.
SHORT="${REPOSITORY#docker.io/}"
SHORT="${SHORT#index.docker.io/}"
DIGEST=""
while IFS= read -r line; do
  case "$line" in
    "$REPOSITORY@sha256:"* | "$SHORT@sha256:"*) DIGEST="${line##*@}" ;;
  esac
done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$REPOSITORY:$TAG")
if ! [[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "The push returned no digest for $REPOSITORY" >&2
  exit 1
fi

if [ "$REGISTRY_HOST" = "docker.io" ] || [ "$REGISTRY_HOST" = "index.docker.io" ]; then
  # An anonymous token: what a node with no login gets. The image is already
  # published at this point, so a connection that drops here must not lose
  # the digest line below.
  RETRY=(--retry 4 --retry-delay 3 --retry-all-errors)
  TOKEN="$(curl -fsS -m 30 "${RETRY[@]}" "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$SHORT:pull" 2> /dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
  ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"
  STATUS="000"
  if [ -n "$TOKEN" ]; then
    STATUS="$(curl -s -m 30 "${RETRY[@]}" -o /dev/null -w '%{http_code}' -I \
      -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT" \
      "https://registry-1.docker.io/v2/$SHORT/manifests/$DIGEST" || true)"
  fi
  case "$STATUS" in
    200)
      echo "A node can pull it: the registry served this digest to a request with no login."
      ;;
    "" | 000*)
      echo "Not checked: the connection failed while the registry was asked whether it serves this digest with no login."
      echo "Run this again to ask it; nothing is uploaded twice."
      ;;
    *)
      echo "The registry did not serve this digest to a request with no login (HTTP $STATUS)." >&2
      echo "Make the repository public, or give the API pull credentials (TRAINING_IMAGE_REGISTRY_*)." >&2
      echo "It is published all the same, as $REPOSITORY@$DIGEST" >&2
      exit 1
      ;;
  esac
else
  echo "Not checked: whether $REGISTRY_HOST serves this repository to a request with no login."
fi

echo "Pushed $REPOSITORY:$TAG"
echo "TRAINING_IMAGE=$REPOSITORY@$DIGEST"
