# Firecracker Sandbox (Local)

Janebot's coding sub-agent now runs inside local Firecracker VMs using `ignite`.

## Host setup

```bash
sudo ./scripts/setup-firecracker.sh
```

This installs/validates:

- `firecracker`
- `ignite`
- `containerd`
- CNI plugins under `/opt/cni/bin`

## Runtime configuration

Optional environment variables:

- `FIRECRACKER_IGNITE_IMAGE` (default: `weaveworks/ignite-ubuntu`)
- `FIRECRACKER_VM_CPUS` (default: `2`)
- `FIRECRACKER_VM_MEMORY` (default: `4GB`)
- `FIRECRACKER_VM_DISK_SIZE` (default: `20GB`)
- `FIRECRACKER_NODE_VERSION` (default: `v22.22.0`)
- `SUBAGENT_PI_CMD` (default: `pi`)

Each Slack thread maps to one VM name derived from `(channel_id, thread_ts)`.

## Notes

- This first version does not apply per-domain egress filtering.
- VM lifecycle and command execution are driven through `sudo ignite ...` from `src/firecracker.ts`.
