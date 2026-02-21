# GitHub PR Event Handling

## Goal

When Jane creates a PR via a Sprite (using `gh pr create`), she should be notified about subsequent PR events — reviews, comments, CI status — so she can respond in the originating Slack thread.

## Current State

- Jane already has a **GitHub App** (`src/github-app.ts`) that mints installation tokens for `gh` CLI access inside Sprites
- Deployed on **Fly.io with no HTTP services** — purely Slack Socket Mode
- No mechanism to track which PRs Jane has created or link them back to Slack threads

## Design

### Architecture

```
GitHub ──webhook──▶ Fly.io HTTP ──▶ janebot ──▶ Slack thread
                    (new port)      (lookup PR → thread mapping)
```

### 1. Track PR creation via Amp Thread ID

Amp automatically adds an `Amp-Thread-ID` trailer to every commit:

```
Amp-Thread-ID: https://ampcode.com/threads/T-019c4bc6-bcf0-733b-9453-a2e1a880809b
```

We use this as the correlation key between GitHub PRs and Slack threads:

1. After sprite execution, `executeInSprite()` already returns `threadId` (the Amp thread/session ID)
2. In `index.ts`, we know the `channelId` and `slackThreadTs` that triggered the execution
3. Store the mapping: `ampThreadId → {slackChannel, slackThreadTs, userId}`
4. When a `pull_request.opened` webhook arrives from the App's bot user, read the head commit's `Amp-Thread-ID` trailer
5. Look up the Amp thread ID in our mapping → we know which Slack thread to notify

No output parsing, no system prompt hacks, no PR body injection. The correlation data is already durable in git.

### 2. Thread-to-Slack mapping

```typescript
// src/pr-tracker.ts

interface SlackThread {
  channel: string         // Slack channel ID
  threadTs: string        // Slack thread timestamp
  userId: string          // Slack user who requested the work
}

// Keyed by Amp Thread ID (e.g. "T-019c4bc6-bcf0-733b-9453-a2e1a880809b")
const threadMap = new Map<string, SlackThread>()

// Called after each sprite execution that returns a threadId
function trackThread(ampThreadId: string, slack: SlackThread): void

// Called from webhook handler — extract Amp-Thread-ID from commit message
function parseAmpThreadId(commitMessage: string): string | undefined {
  const match = commitMessage.match(/Amp-Thread-ID:\s*https:\/\/ampcode\.com\/threads\/(T-[\w-]+)/)
  return match?.[1]
}

// Look up Slack thread for a given Amp Thread ID
function getSlackThread(ampThreadId: string): SlackThread | undefined
```

Start in-memory. Persist to a JSON file or SQLite later if needed (aligns with Phase 4 in PLAN.md).

### 3. Receive GitHub webhooks

#### Fly.io HTTP service

Add an HTTP service to `fly.toml`:

```toml
[[services]]
  internal_port = 3000
  protocol = "tcp"

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

#### Webhook endpoint

Add a minimal HTTP server alongside the Slack Bolt app. Bolt's Socket Mode doesn't use HTTP, so there's no conflict.

```typescript
// src/github-webhooks.ts
import { createServer } from "http"
import { createHmac } from "crypto"

interface WebhookHandler {
  start(port: number): Promise<void>
  onPrEvent(handler: (event: GitHubPrEvent) => Promise<void>): void
}
```

**Events to subscribe to on the GitHub App:**

| Event | Trigger |
|---|---|
| `pull_request_review` | Someone approves/requests changes |
| `pull_request_review_comment` | Inline code comment on the PR |
| `issue_comment` | Top-level PR comment |
| `pull_request` | PR merged, closed, or updated |
| `check_suite` / `check_run` | CI passes or fails |

**Webhook signature verification** using `GITHUB_WEBHOOK_SECRET` env var — verify the `X-Hub-Signature-256` header against the payload.

### 4. Process events

When a webhook arrives:

1. Extract `owner/repo#number` from the payload
2. Look up the PR-to-thread mapping
3. If no mapping exists, ignore (it's not Jane's PR)
4. If mapped, decide what to do:

| Event | Action |
|---|---|
| Review approved | Post "✅ PR approved by @reviewer" to Slack thread |
| Changes requested | Run Amp to address the review feedback |
| Review comment | Run Amp to respond to the specific comment |
| PR comment | Run Amp to respond |
| CI failed | Run Amp to investigate and fix |
| PR merged | Post "🎉 PR merged" to Slack thread, clean up mapping |
| PR closed | Post "PR closed" to Slack thread, clean up mapping |

For events that trigger Amp (review comments, CI failures), the prompt should include:
- The original Slack thread context
- The PR diff or specific review comment
- Instructions to push fixes to the same branch

### 5. File structure

```
src/
├── github-webhooks.ts    # HTTP server, signature verification, event parsing
├── pr-tracker.ts         # PR-to-thread mapping, PR URL extraction
├── github-app.ts         # (existing) token minting
└── index.ts              # Wire up webhook server alongside Slack app
```

### 6. Configuration

New env vars:

```
GITHUB_WEBHOOK_SECRET=<secret>     # For verifying webhook signatures
GITHUB_WEBHOOK_PORT=3000           # Port for the HTTP server (default: 3000)
```

The GitHub App already has `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID`.

### 7. GitHub App permissions update

The GitHub App needs these additional permissions:
- **Pull requests**: Read (already likely have this)
- **Checks**: Read (for CI status)

And webhook event subscriptions added via the GitHub App settings page.

## Implementation phases

### Phase A: Thread tracking
- After sprite execution, store `ampThreadId → {slackChannel, slackThreadTs, userId}` mapping
- Add `pr-tracker.ts` with `parseAmpThreadId()` to extract thread IDs from commit messages
- Wire into `index.ts` after `runAmp()` returns a `threadId`

### Phase B: Webhook receiver
- Add HTTP server with webhook signature verification
- On `pull_request.opened` from App bot user: fetch head commit, parse `Amp-Thread-ID` trailer, store PR→thread mapping
- Wire into `main()` startup
- Update `fly.toml` to expose the port
- Configure GitHub App webhook URL to `https://buildkite-janebot.fly.dev/github/webhooks`

### Phase C: Notification events
- Handle `pull_request` (merged/closed) → post to Slack
- Handle `pull_request_review` (approved) → post to Slack

### Phase D: Interactive events
- Handle review comments → run Amp to address feedback
- Handle CI failures → run Amp to investigate
- Push fixes back to the PR branch

## Open questions

1. **Scope of repos** — Should Jane handle webhooks for all repos the GitHub App is installed on, or filter to specific ones?
2. **Rate limiting** — If a PR gets a flood of review comments, should we debounce them (similar to Slack message debouncing)?
3. **Branch access in Sprites** — Sprites currently start clean. To push fixes to an existing PR branch, the Sprite needs to clone the repo and check out that branch. Is the current runner pool setup compatible with this?
4. **Concurrency** — A webhook event could arrive while Jane is already processing a Slack message for the same thread. Need to handle the `inFlight` set correctly.
