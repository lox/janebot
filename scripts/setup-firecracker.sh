#!/usr/bin/env bash
set -euo pipefail

# Minimal host bootstrap for local Firecracker VMs managed by Ignite.
# Supports Ubuntu/Debian and Amazon Linux (dnf).

IGNITE_VERSION="${IGNITE_VERSION:-v0.10.0}"
CNI_PLUGINS_VERSION="${CNI_PLUGINS_VERSION:-v1.5.1}"
FIRECRACKER_VERSION="${FIRECRACKER_VERSION:-v1.14.1}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (e.g. sudo scripts/setup-firecracker.sh)"
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    iptables \
    jq \
    socat \
    tar \
    util-linux \
    containerd
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y \
    ca-certificates \
    iptables \
    jq \
    socat \
    tar \
    util-linux \
    containerd
else
  echo "Unsupported host package manager (need apt-get or dnf)"
  exit 1
fi

systemctl enable --now containerd

arch="$(uname -m)"
case "${arch}" in
  x86_64) fc_arch="x86_64"; cni_arch="amd64"; ignite_arch="amd64" ;;
  aarch64) fc_arch="aarch64"; cni_arch="arm64"; ignite_arch="arm64" ;;
  *) echo "Unsupported architecture: ${arch}" ; exit 1 ;;
esac

if ! command -v firecracker >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  curl -fsSL -o "$tmp_dir/firecracker.tgz" \
    "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${fc_arch}.tgz"
  tar -xzf "$tmp_dir/firecracker.tgz" -C "$tmp_dir"
  install -m 0755 "$tmp_dir/release-${FIRECRACKER_VERSION}-${fc_arch}/firecracker-${FIRECRACKER_VERSION}-${fc_arch}" /usr/local/bin/firecracker
fi

if ! command -v ignite >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  curl -fsSL -o "$tmp_dir/ignite" \
    "https://github.com/weaveworks/ignite/releases/download/${IGNITE_VERSION}/ignite-${ignite_arch}"
  install -m 0755 "$tmp_dir/ignite" /usr/local/bin/ignite
fi

mkdir -p /opt/cni/bin
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL -o "$tmp_dir/cni.tgz" \
  "https://github.com/containernetworking/plugins/releases/download/${CNI_PLUGINS_VERSION}/cni-plugins-linux-${cni_arch}-${CNI_PLUGINS_VERSION}.tgz"
tar -xzf "$tmp_dir/cni.tgz" -C /opt/cni/bin

modprobe kvm || true
modprobe vhost_net || true

echo "Firecracker setup complete."
echo "ignite: $(ignite version | head -n 1 || true)"
echo "firecracker: $(firecracker --version | head -n 1 || true)"
