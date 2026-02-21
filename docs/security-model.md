# Security model

Jane runs untrusted prompts from Slack users by delegating coding work to sandboxed Sprites.

## Execution environments

Jane now has two tiers:

### Host orchestrator

The Fly host runs the Slack control loop and a top-level Pi orchestrator session. The host orchestrator has no built-in file/shell tools and delegates coding work through a single brokered tool (`run_coding_subagent`).

### Coding subagents (Sprites)

Each Slack thread is mapped to a dedicated Sprite + Pi session. The session is long-lived and reused across follow-up messages in that thread.

Session metadata is persisted locally in SQLite (`SESSION_DB_PATH`) so thread-to-session mappings survive host process restarts.

Key properties:
- Isolation boundary is per Slack thread (not per reply)
- Session state persists across turns for velocity
- Subagents are not shared across different Slack threads

## Network policy

Sprites can only reach explicitly allowed domains. The allowlist is defined in `src/coding-subagent.ts` and includes:

- LLM/provider infra (`api.anthropic.com`, `api.openai.com`, Google storage/APIs, Cloudflare)
- Package install domains (`registry.npmjs.org`, `*.npmjs.org`, `*.npmjs.com`)
- GitHub (`github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`)

All other egress is denied.

## GitHub credentials

Jane uses a GitHub App to mint short-lived installation tokens on the host.

- Tokens are minted in `src/github-app.ts`
- Tokens are injected into worker env as `GH_TOKEN`
- No long-lived PATs are used

## Authorization

Access control is enforced before execution:

- `ALLOWED_USER_IDS`: allowed Slack user IDs (empty = allow all)
- `ALLOWED_CHANNEL_IDS`: allowed Slack channel IDs (empty = allow all)

## Secrets handling

- `SPRITES_TOKEN`, Slack tokens, and GitHub App private key stay on host
- Worker receives only scoped runtime credentials (`ANTHROPIC_API_KEY`, optional short-lived `GH_TOKEN`)

## Trade-off

This model intentionally trades strict per-reply reset for compounding velocity. Governing controls focus on:
- Per-thread isolation
- Restricted egress
- Short-lived credentials
