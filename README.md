<img src="assets/icon.png" width="128" alt="Jane" />

# janebot

Jane is a Slack bot that orchestrates long-lived coding subagents in local Firecracker VMs. She has opinions and won't say "Great question!".

[SOUL.md](./SOUL.md) defines her personality. [docs/threads.md](./docs/threads.md) explains the thread model. [docs/security-model.md](./docs/security-model.md) covers isolation, credentials, and what Jane can and can't do.

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) using `slack-manifest.yaml`
2. Generate an App-Level Token with `connections:write` scope
3. Install to your workspace

```bash
cp .env.example .env
# Add your tokens

pnpm install
pnpm dev
```

Mention `@janebot` in a channel or DM her.

## Architecture

- Top-level Jane is a persistent Pi orchestrator session per Slack thread.
- Host orchestrator runs with no built-in file/shell tools and delegates via `run_coding_subagent`.
- Each Slack thread gets a sticky coding subagent session in a dedicated Firecracker VM.
- Follow-up messages in the same Slack thread continue the same Pi session.
- Use `/status` in a thread to inspect subagent status, and `/abort` to stop a running coding job.

## Config

| Variable | What it does |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`) |
| `ANTHROPIC_API_KEY` | From your Anthropic account |
| `WORKSPACE_DIR` | Where Jane works |
| `PI_MODEL` | LLM model (optional, defaults to claude-opus-4-6) |
| `FIRECRACKER_IGNITE_IMAGE` | Ignite image for subagent VMs (default: `weaveworks/ignite-ubuntu`) |
| `FIRECRACKER_VM_CPUS` | vCPU count for each VM (default: `2`) |
| `FIRECRACKER_VM_MEMORY` | Memory per VM (default: `4GB`) |
| `FIRECRACKER_VM_DISK_SIZE` | Disk size per VM (default: `20GB`) |
| `FIRECRACKER_NODE_VERSION` | Node version bootstrapped in VM if needed (default: `v22.22.0`) |
| `SUBAGENT_PI_CMD` | Pi binary name/path inside VM (default: `pi`) |
| `JANE_LOG_LEVEL` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `ALLOWED_USER_IDS` | Who can talk to her |
| `ALLOWED_CHANNEL_IDS` | Where she listens |

Empty allowlists mean no restrictions.

## Run locally

```bash
pnpm dev
```

Logs show requests and response times. Restart to pick up changes.

## Deploy

```bash
fly launch --copy-config
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```
