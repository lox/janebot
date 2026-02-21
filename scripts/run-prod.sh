#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IMAGE_REPO="${SANDBOX_IMAGE_REPO:-ghcr.io/buildkite/janebot-sandbox}"
SANDBOX_TAG="$(node "$ROOT_DIR/scripts/sandbox-image-tag.mjs")"
RESOLVED_IMAGE="${DOCKER_SANDBOX_IMAGE:-${IMAGE_REPO}:${SANDBOX_TAG}}"

echo "Using sandbox image: ${RESOLVED_IMAGE}"

if [[ "${SKIP_SANDBOX_PULL:-0}" != "1" ]]; then
  docker pull "${RESOLVED_IMAGE}"
fi

export DOCKER_SANDBOX_IMAGE="${RESOLVED_IMAGE}"

exec pnpm start
