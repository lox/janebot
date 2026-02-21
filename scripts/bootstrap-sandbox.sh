#!/bin/bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-0.52.9}"

# Install pi-coding-agent
if ! command -v pi >/dev/null 2>&1; then
  echo "==> Installing pi-coding-agent@${PI_VERSION}"
  npm install -g "@mariozechner/pi-coding-agent@${PI_VERSION}"
else
  echo "==> pi-coding-agent already installed"
fi

# Install GitHub CLI (optional — don't fail if it doesn't work)
if ! command -v gh >/dev/null 2>&1; then
  echo "==> Installing GitHub CLI"
  (
    if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | $SUDO dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | $SUDO tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq gh
  ) || echo "WARN: GitHub CLI install failed, continuing without it"
else
  echo "==> GitHub CLI already installed"
fi

# Ensure mise is on PATH (installed in Dockerfile, lives in ~/.local/bin)
export PATH="$HOME/.local/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  echo "==> mise already installed: $(mise --version)"
else
  echo "==> Installing mise"
  curl -fsSL https://mise.run | sh
  mise settings set experimental true
fi

# Create artifacts directory
mkdir -p "$HOME/artifacts"

# Print versions
echo "==> Bootstrap complete"
echo "pi: $(pi --version 2>/dev/null || echo 'not installed')"
echo "gh: $(gh --version 2>/dev/null | head -1 || echo 'not installed')"
echo "mise: $(mise --version 2>/dev/null || echo 'not installed')"
echo "node: $(node --version)"
