# Plan: Replace Amp with Pi

**Status:** Draft
**Date:** 2025-02-12

## Summary

Replace the Amp SDK and CLI with [Pi](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) as the underlying agent. Keep Sprites for sandboxing. Keep janebot's stateless-per-message architecture.

Capabilities that Amp provided but Pi doesn't (painter, web search, librarian, oracle, etc.) are out of scope for this plan. Ship Pi first, observe what's actually missing from real usage, then address gaps.

## Motivation

- Pi has a minimal core (4 tools: read, write, edit, bash) with a powerful extension system
- Multi-provider support (Anthropic, OpenAI, Google, xAI, etc.) built in
- Self-extending — the agent builds its own tools rather than relying on pre-built integrations
- Active community and well-maintained codebase (10k+ stars)

## Architecture decisions

### Keep janebot, don't fork mom

Pi's own Slack bot ([mom](https://github.com/badlogic/pi-mono/tree/main/packages/mom)) validates the concept but has fundamental architectural differences:

- mom uses persistent sessions per channel with `context.jsonl` + `log.jsonl`
- mom assumes host-run + Docker sandbox, not Sprites with checkpoint/restore
- mom maintains per-channel memory (`MEMORY.md`) and event scheduling

Adopting mom's model would be a product/UX change (retention, cross-user leakage, cleanup) not just a backend swap. **Borrow ideas** from mom (event patterns, memory boundaries) but keep janebot's codebase and stateless model.

### Start with JSON mode, design for RPC later

Pi has two non-interactive output modes:
- `--mode json` — JSONL events on stdout, simple to parse
- `--mode rpc` — bidirectional JSON-RPC on stdin/stdout, supports cancel/pause/state queries

Abstract the runner behind an interface so the transport can be swapped:

```typescript
interface PiRunner {
  run(prompt: string, systemPrompt: string): Promise<PiRunResult>
}

interface PiRunResult {
  content: string
  artifacts: ArtifactFile[]
}
```

Implement `PiJsonRunner` first. Add `PiRpcRunner` only if JSON parsing proves flaky or we need streaming/cancellation.

### Pass prompt via stdin, not shell interpolation

⚠️ **Do not** pass the user prompt via `bash -c "... ${prompt}"` — that's a shell injection vector. Use the Sprites exec API's `stdin` option to pipe the prompt to Pi's stdin:

```typescript
// WRONG — shell injection
const args = ["bash", "-c", `${PI_BIN} --mode json --no-session "${prompt}"`]

// RIGHT — prompt via stdin
const result = await spritesClient.exec(spriteName,
  [PI_BIN, "--mode", "json", "--no-session"],
  { env, stdin: prompt + "\n", timeoutMs: EXEC_TIMEOUT_MS })
```

This matches how Amp was invoked (the current code already uses `stdin`).

### Artifact export replaces painter

Amp had `painter` for image generation with inline base64 data in the stream. Pi has no equivalent built-in. Replace with a generic artifact convention:

1. Clean artifacts dir at start of each run: `rm -rf /home/sprite/artifacts && mkdir -p /home/sprite/artifacts`
2. System prompt instructs Pi: "Write any generated files to `/home/sprite/artifacts/`"
3. After execution, janebot runs `find /home/sprite/artifacts -type f` via `spritesClient.exec()`
4. Downloads files via `spritesClient.downloadFile()`
5. Uploads to Slack thread

Limits:
- Max 10 artifact files per execution
- Max 10MB per file
- Max 25MB total upload per execution
- Sanitise filenames (no `..`, no path traversal)

## Execution paths

### Path 1: Sprite execution (production)

**Current:**
```
Slack → janebot → Sprites API → amp --execute --stream-json → parse Amp JSON → respond
```

**New:**
```
Slack → janebot → Sprites API → pi --mode json --no-session (stdin: prompt) → parse Pi JSON → collect artifacts → respond
```

### Path 2: Local execution (dev/testing)

**Current:**
```
Slack → janebot → amp-sdk execute() → iterate StreamMessage → respond
```

**New:**
```
Slack → janebot → createAgentSession() → session.prompt() → subscribe to events → respond
```

## Phases

### Phase 0: Spike ✅ COMPLETE

Ran `scripts/spike-pi-in-sprite.ts` — all questions answered.

#### Findings

| Question | Answer |
|---|---|
| Install method | `npm install -g @mariozechner/pi-coding-agent@0.52.9` — 266 packages, ~17s |
| Binary location | `$(npm prefix -g)/bin/pi` → `/.sprite/languages/node/nvm/versions/node/v22.20.0/bin/pi` |
| Output format | Clean JSONL on stdout, stderr empty during normal operation |
| AGENTS.md | Pi reads from CWD (`/home/sprite`). Write before execution. |
| Default model | `claude-opus-4-6` via Anthropic (auto-detected from `ANTHROPIC_API_KEY`) |
| Invalid model handling | ⚠️ Silently falls back to default, exit code 0 |
| Network requirements | Only LLM provider domains needed at runtime. `registry.npmjs.org` needed at install (baked into checkpoint). No Pi-specific domains. |
| Multi-provider | Pi supports Anthropic, OpenAI, Google, xAI, OpenRouter, etc. — key auto-detected from env vars |
| PATH | Must use sprite's full PATH (includes `/.sprite/languages/node/...`) so Pi can find node |

#### JSON event lifecycle

```
session → agent_start → turn_start →
  message_start(user) → message_end(user) →
  message_start(assistant) → message_update(text_start) →
    message_update(text_delta)* → message_update(text_end) →
  message_end(assistant) →
  turn_end → agent_end
```

With tool use, the cycle extends:

```
  message_start(assistant) → message_update(toolcall_start) →
    message_update(toolcall_delta)* → message_update(toolcall_end) →
  message_end(assistant) →
  tool_execution_start → tool_execution_update → tool_execution_end →
  message_start(toolResult) → message_end(toolResult) →
  turn_end →
  turn_start → [next turn repeats] →
  turn_end → agent_end
```

#### Extracting the final answer

Use `agent_end.messages` — find the last message with `role: "assistant"` and `content[].type === "text"`. This is more reliable than accumulating deltas.

#### Key event shapes

```typescript
// Session start
{ type: "session", version: 3, id: string, timestamp: string, cwd: string }

// Text streaming
{ type: "message_update", assistantMessageEvent: {
    type: "text_delta", contentIndex: number, delta: string,
    message: { role: "assistant", content: [{ type: "text", text: string }], ... }
}}

// Tool call
{ type: "tool_execution_start", toolCallId: string, toolName: string, args: Record<string, unknown> }
{ type: "tool_execution_end", toolCallId: string, toolName: string, result: { content: [{ type: "text", text: string }] }, isError: boolean }

// Completion — use this for the final answer
{ type: "agent_end", messages: Array<{ role: string, content: Array<{ type: string, text?: string }>, ... }> }
```

#### Usage and cost info

Every assistant `message_end` and `turn_end` includes usage data:
```typescript
{ usage: { input: number, output: number, cacheRead: number, cacheWrite: number,
           totalTokens: number, cost: { input: number, output: number, total: number } } }
```

### Phase 1: Sprite execution (~half day)

Swap the binary inside Sprite containers. This is the production path.

#### `src/sprite-runners.ts`

- Replace install command:
  ```bash
  # Before
  curl -fsSL https://ampcode.com/install.sh | bash
  # After
  npm install -g @mariozechner/pi-coding-agent@0.52.9
  ```
- Change `AMP_BIN` to `PI_BIN`: `$(npm prefix -g)/bin/pi` (resolves to `/.sprite/languages/node/nvm/versions/node/v22.20.0/bin/pi`)
- Must use sprite's default PATH (not a hardcoded one) so Pi can find node
- Update network policy:
  - Remove: `ampcode.com`, `*.ampcode.com`
  - Add: `registry.npmjs.org` (for npm install, baked into checkpoint)
  - Keep: `api.anthropic.com`, `api.openai.com`, `*.googleapis.com`, GitHub domains
- Bump checkpoint version to `clean-v3` to force rebuild

#### `src/sprite-executor.ts`

- Rename `parseAmpOutput()` → `parsePiOutput()` with Pi's JSON event format
- Change CLI invocation — **pass prompt via stdin** (not shell interpolation):
  ```typescript
  // Before
  const args = [AMP_BIN, "--execute", "--stream-json", "--dangerously-allow-all",
                "--mode", config.agentMode, "--log-level", "warn",
                "--settings-file", settingsFile]
  const result = await spritesClient.exec(spriteName, args, { env, stdin: prompt + "\n", ... })

  // After
  const args = [PI_BIN, "--mode", "json", "--no-session"]
  const result = await spritesClient.exec(spriteName, args, { env, stdin: prompt + "\n", ... })
  ```
- Replace amp settings file with `AGENTS.md`:
  ```typescript
  // Before: write /tmp/amp-settings.json with JSON config
  // After: write /home/sprite/AGENTS.md with system prompt content (Pi reads from CWD)
  ```
- Replace `AMP_API_KEY` env var with `ANTHROPIC_API_KEY` (Pi auto-detects provider from env var name)
- Must pass sprite's default PATH in env (not a hardcoded subset) so Pi can find node
- Clean and collect artifacts:
  ```typescript
  // Before execution: clean artifacts dir
  await spritesClient.exec(spriteName,
    ["bash", "-c", "rm -rf /home/sprite/artifacts && mkdir -p /home/sprite/artifacts"],
    { timeoutMs: 10000 })

  // After pi finishes: collect artifacts
  const artifactResult = await spritesClient.exec(spriteName,
    ["find", "/home/sprite/artifacts", "-type", "f", "-maxdepth", "2"],
    { timeoutMs: 10000 })
  const artifactPaths = artifactResult.stdout.trim().split("\n").filter(Boolean)
  ```
- Verify model in response matches configured model:
  ```typescript
  // Pi silently falls back to default on invalid model — detect this
  const sessionEvent = events.find(e => e.type === "session")
  const firstAssistant = events.find(e => e.type === "message_start" && e.message?.role === "assistant")
  if (firstAssistant?.message?.model && firstAssistant.message.model !== config.piModel) {
    log.warn("Pi used different model than configured", {
      configured: config.piModel, actual: firstAssistant.message.model
    })
  }
  ```
- Design parser as tolerant state machine:
  - Ignore unknown event types
  - Collect final answer from `agent_end.messages`, not deltas
  - Define "success" as: `agent_end` event present AND last assistant message has text content
  - If no `agent_end`, treat as error regardless of exit code

#### `src/sprite-executor.test.ts`

- Rewrite tests for `parsePiOutput()` using Pi's actual JSON event format (captured in spike)
- Add test for artifact path extraction
- Add test for model mismatch detection
- Remove painter/image-specific test cases

#### `src/config.ts`

- Remove `agentMode`
- Add `piModel` — Pi defaults to `claude-opus-4-6` when `ANTHROPIC_API_KEY` is set (auto-detected). Override via `--model` flag if needed.
- Add `piThinkingLevel` (default: `off` — Pi's default; map from Amp's smart→medium if desired)
- Rename env var references: `AMP_API_KEY` → `ANTHROPIC_API_KEY`
- Remove `mcpServers` config — MCP isn't used in production (sprites path never passes it)

#### `.env.example`

```bash
# Before
AMP_API_KEY=your-amp-api-key
AGENT_MODE=smart

# After
ANTHROPIC_API_KEY=sk-ant-...
# PI_MODEL is optional — Pi defaults to claude-opus-4-6 with Anthropic
# PI_THINKING_LEVEL is optional — defaults to off
```

### Phase 2: System prompt and personality (~30min)

- Move `SOUL.md` content into the `AGENTS.md` that gets written to sprites
- Remove painter-specific instructions from SOUL.md
- Add artifact convention:
  ```markdown
  ## File Output
  If you generate any files the user should receive (images, diagrams, archives),
  write them to `/home/sprite/artifacts/` and mention the filenames in your response.
  ```
- Update privacy/thread section — remove references to `find_thread`/`read_thread` tools. Replace with: "You cannot access other conversations. You only see the provided Slack thread history and workspace files."
- Remove references to tools that don't exist in Pi (mermaid, oracle, librarian, painter, etc.)

### Phase 3: Local execution / SDK swap (~1-3h)

#### `package.json`

- Remove `@sourcegraph/amp-sdk`
- Add `@mariozechner/pi-coding-agent`

#### `src/index.ts`

Replace `runAmpLocal()`:

```typescript
import { getModel } from "@mariozechner/pi-ai"
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent"

// Create once at startup, not per request
const authStorage = new AuthStorage()
const modelRegistry = new ModelRegistry(authStorage)

// Set API key from env at startup
if (process.env.ANTHROPIC_API_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY)
}

async function runPiLocal(
  prompt: string,
  userId: string
): Promise<{ content: string; threadId: string | undefined }> {
  const model = getModel("anthropic", config.piModel)

  const { session } = await createAgentSession({
    model,
    thinkingLevel: config.piThinkingLevel,
    sessionManager: SessionManager.inMemory(), // stateless per message
    authStorage,
    modelRegistry,
    systemPromptOverride: () => buildSystemPrompt(userId),
  })

  let content = ""
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update"
        && event.assistantMessageEvent.type === "text_delta") {
      content += event.assistantMessageEvent.delta
    }
  })

  try {
    await session.prompt(prompt)
  } finally {
    unsubscribe() // prevent memory leaks in long-running process
  }

  return { content, threadId: session.sessionId }
}
```

Key points:
- `AuthStorage` and `ModelRegistry` created once at startup (not per request)
- Explicit `unsubscribe()` in `finally` to prevent memory leaks
- Use `setRuntimeApiKey()` for env-based auth

Remove `LOCAL_ENABLED_TOOLS` — Pi only has 4 tools by default.

#### `scripts/repl.ts`

- Same SDK swap as `index.ts`
- For REPL, use `SessionManager.create()` instead of `inMemory()` to enable session continuation

## File change summary

| File | Phase | Change |
|---|---|---|
| `src/sprite-runners.ts` | 1 | Modify — install command, binary path, network policy, checkpoint version |
| `src/sprite-executor.ts` | 1 | Major rewrite — CLI args, output parsing, artifact collection |
| `src/sprite-executor.test.ts` | 1 | Rewrite — new output format tests |
| `src/config.ts` | 1 | Modify — rename/replace config fields |
| `.env.example` | 1 | Modify — env var names |
| `SOUL.md` | 2 | Modify — remove painter instructions, update tool references |
| `AGENTS.md` | 2 | Modify — update build/run commands |
| `package.json` | 3 | Modify — swap dependency |
| `src/index.ts` | 3 | Major rewrite — SDK swap, remove Amp types |
| `scripts/repl.ts` | 3 | Major rewrite — SDK swap |
| `Dockerfile` | 1 | Check — may need adjustments |
| `README.md` | 3 | Update — new setup instructions |

## Known capability gaps (post-migration)

These Amp tools won't exist in Pi. Assess after migration based on real usage:

| Amp tool | Impact | Notes |
|---|---|---|
| `painter` (image gen) | Medium | Could add via bash + API calls, or a future tool service |
| `web_search` / `read_web_page` | Medium | Pi can `curl` from sprites if domains are in allowlist. Or add a tool service later. |
| `mermaid` (diagrams) | Low | Install `@mermaid-js/mermaid-cli` in sprite, render via bash |
| `librarian` (codebase Q&A) | Low | Pi's read/bash/grep covers most cases |
| `oracle` (sub-agent) | Low | [pi-subagents](https://github.com/nicobailon/pi-subagents) extension exists |
| `look_at` (image/PDF analysis) | Low | Could add via tool service |
| MCP servers | None | Not used in production (sprites path never passes MCP config) |

If multiple gaps need filling, a separate tool service (`jane-tools`) with a thin CLI on the sprite is the likely approach. But build it when we have data, not now.

## Risks and mitigations

### A) Output format stability (mitigated ✅)
Spike confirmed: clean JSONL on stdout, stderr empty, stable event types (`session`, `agent_start`, `message_update`, `tool_execution_*`, `agent_end`). `agent_end.messages` provides the final answer reliably.

**Remaining risk:** Schema may change across Pi versions. Pin the version and build parser tolerantly — ignore unknown events.

### B) npm install + network policy (mitigated ✅)
Spike confirmed: install works with `registry.npmjs.org`, `*.npmjs.org`, `*.npmjs.com` in allowlist. 266 packages, ~17s. No other domains needed.

**Mitigation:** Pin version (`0.52.9`), bake install into checkpoint. npm domains only needed during provisioning, not execution.

### C) Silent model fallback
Pi silently falls back to default model on invalid `--model` flag (exit code 0). Could cause unexpected cost or quality drift.

**Mitigation:** Check the model reported in `message_start` events against the configured model. Log a warning on mismatch. Consider failing fast in non-prod.

### D) Artifact export reliability
No structured "here are my files" event — relies on convention (write to `/home/sprite/artifacts/`).

**Mitigation:** System prompt is explicit. Clean dir before each run. Add `find` call after execution. Enforce size/count limits. Worst case: files aren't uploaded but the text response still works.

### E) Stateless session guardrails
Pi assumes persistent sessions by default. In stateless mode we need to ensure:
- `--no-session` prevents on-disk context files from persisting between runs
- Checkpoint/restore gives clean state regardless, but verify
- No accidental context leakage between users

**Mitigation:** `--no-session` flag + checkpoint restore after each execution.

### F) Provider key management
Moving from single `AMP_API_KEY` to per-provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.). Pi supports Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, and more.

**Mitigation:** Start with one provider. Pi's `AuthStorage` handles multi-provider gracefully — keys are resolved from env vars automatically.

### G) Checkpoint size / provision time
`npm install -g` is heavier than Amp's install script. May increase initial sprite provisioning.

**Mitigation:** Provision is a one-time cost baked into the checkpoint. Monitor and optimise if needed.

## Suggested order

1. ~~**Phase 0: Spike** — validate Pi in a sprite, capture output format~~ ✅ Done
2. **Phase 1: Sprite execution** — swap the binary, add artifact export
3. **Phase 2: System prompt** — update SOUL.md / AGENTS.md
4. **Phase 3: Local SDK** — swap for dev/testing
5. **Observe** — run in production, identify actual capability gaps
6. **Address gaps** — build tool service or extensions based on real data
