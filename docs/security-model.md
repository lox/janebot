# Security model

Jane runs untrusted prompts from Slack users inside sandboxed VMs. This document covers the isolation boundaries, credential handling, and what Jane can and can't do.

## Execution environments

Jane supports two execution modes. Only one should be active at a time.

### Sprites (recommended)

Each request runs inside a [Sprites](https://sprites.dev) Firecracker microVM. A pool of runner sprites is initialised at startup with Amp and `gh` pre-installed, then checkpointed. Each request acquires a runner, executes, and restores to the clean checkpoint afterwards. This gives hardware-level isolation with clean state between requests.

Key properties:
- Filesystem changes don't persist between requests (checkpoint restore)
- Network egress is restricted to an allowlist (see below)
- Credentials are injected per-request and discarded on restore
- Runners are shared across users but never concurrently

### Local execution

For single-user trusted setups only. Runs Amp directly on the host with no sandbox. Requires `ALLOW_LOCAL_EXECUTION=true`. Not suitable for multi-user deployments.

## Network policy

Sprites can only reach explicitly allowed domains. The current allowlist in `src/sprite-runners.ts`:

| Domain | Purpose |
|--------|---------|
| `ampcode.com`, `*.ampcode.com` | Amp CLI and API |
| `storage.googleapis.com`, `*.googleapis.com` | Amp infrastructure |
| `api.anthropic.com` | LLM API |
| `api.openai.com` | LLM API |
| `*.cloudflare.com` | CDN |
| `github.com`, `*.github.com`, `api.github.com` | GitHub access |

All other egress is denied.

## GitHub credentials

Jane uses a dedicated GitHub App to get short-lived installation tokens. No long-lived personal access tokens are used.

### How it works

1. On startup, janebot loads the GitHub App's private key (`GITHUB_APP_PRIVATE_KEY`)
2. Before each request, `src/github-app.ts` mints a 1-hour installation access token via the GitHub App JWT flow
3. Tokens are cached and refreshed 5 minutes before expiry
4. The token is used to authenticate `gh` inside the sprite (`gh auth login --with-token`)
5. `GH_TOKEN` is also set in the environment so tools that read it directly work
6. On checkpoint restore after the request, the token is discarded

### GitHub App permissions

The GitHub App is configured with minimal permissions:

| Permission | Level | Why |
|------------|-------|-----|
| Contents | Read & write | Push feature branches |
| Pull requests | Read & write | Create and update PRs |
| Metadata | Read | Required by GitHub |

The app does NOT have administration, merge queue, or branch protection bypass permissions.

### Branch protection

This is a deliberate security constraint. Jane can:
- Create branches
- Push commits to feature branches
- Open and update pull requests

Jane cannot:
- Push directly to protected branches (e.g. `main`)
- Merge pull requests without required reviews
- Bypass branch protection rules

A human must approve and merge any PR that Jane creates.

### Configuration

Three environment variables configure the GitHub App:

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_APP_INSTALLATION_ID=78901234
```

The private key uses `\n` for newlines when stored as a single-line env var. If these aren't set, GitHub access is simply not available in the sprite.

## Amp tool restrictions

### Sprite execution

When running in a sprite, Amp has full tool access (`--dangerously-allow-all`). This is safe because the sprite itself is the security boundary. The filesystem, network, and credentials are all scoped to the disposable VM.

### Local execution

When running locally, a restricted tool allowlist is applied (`src/index.ts`):

```
Bash, create_file, edit_file, finder, glob, Grep, librarian,
look_at, mermaid, oracle, Read, read_web_page, skill, Task,
undo_edit, web_search, painter
```

`find_thread` and `read_thread` are excluded to prevent cross-user thread access. `handoff` and `task_list` are also excluded.

## Authorisation

Two layers of access control gate who can talk to Jane:

- `ALLOWED_USER_IDS`: Slack user IDs permitted to interact. Empty means allow all.
- `ALLOWED_CHANNEL_IDS`: Slack channel IDs where Jane will respond. Empty means allow all.

Both are checked before any execution begins. Unauthorised requests are silently dropped.

## Secrets handling

- `GITHUB_APP_PRIVATE_KEY` never enters the sprite. Only the minted installation token is passed in.
- `SPRITES_TOKEN` is used by the host process only, never exposed to sprites.
- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are used by the host process only.
- `AMP_API_KEY` is passed into the sprite environment. See the caveat below.

### AMP_API_KEY exposure

The `AMP_API_KEY` is passed into the sprite so that Amp can authenticate with the Amp API. This is a known security trade-off. The key is shared across all sprite executions, which means code running inside a sprite could use it to:

- Read or search other Amp threads created by this bot (including threads from other Slack users)
- Continue or modify conversations from other users
- Access any thread data the key has permission to read

We partially mitigate this by disabling `find_thread` and `read_thread` in the tool allowlist, but this is soft isolation. A prompt injection or malicious tool use could bypass the allowlist by calling the Amp API directly via `curl` or similar.

Possible future mitigations:
- **Per-request Amp tokens**: Mint scoped tokens that can only access threads created in that session. Requires Amp API support for token scoping.
- **Amp API proxy**: Keep the real key on the host and proxy requests from the sprite, filtering by thread ID.
- **Network policy restriction**: Remove `ampcode.com` from the sprite's network allowlist and run Amp in a mode that doesn't require API access from inside the sprite. Not currently feasible with the CLI execution model.

For now, this risk is accepted. The sprite's network policy limits where the key can be exfiltrated to, and checkpoint restore discards it after each request.

## Remaining risks

| Risk | Status | Notes |
|------|--------|-------|
| Prompt injection | Mitigated | Sprite sandbox limits blast radius |
| AMP_API_KEY in sprite | Accepted | Could access other users' threads; see above |
| Cross-user via shared runners | Mitigated | Checkpoint restore clears state between requests |
| MCP server credentials | Not scoped | Global config shared across all users |
| No per-user rate limiting | Open | Could be added to prevent abuse |
