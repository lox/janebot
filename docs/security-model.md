# Security & Isolation Model

This document describes the threat model and isolation strategies for janebot's multi-user environment.

## Threat Model

### Cross-User Risks

| Attack Vector | Current State | Mitigation |
|---------------|---------------|------------|
| Thread search/read across threads | ✅ Tools disabled via whitelist | Keep disabled |
| Prompt injection to bypass rules | ⚠️ Soft isolation via system prompt | Defense in depth |
| Workspace file access across threads | ⚠️ Shared WORKSPACE_DIR | Sprites (per-thread sandbox) |

### Tool Risks

| Tool | Risk Level | Notes |
|------|------------|-------|
| `Bash` | 🔴 High | Shell access, can bypass filesystem restrictions |
| `Read`, `glob`, `Grep` | 🟡 Medium | Can read any accessible files |
| `create_file`, `edit_file` | 🟡 Medium | Can modify any writable files |
| MCP servers | 🟡 Medium | Depends on what they access |
| `find_thread`, `read_thread` | 🔴 High | Cross-user thread access (disabled) |

## Isolation Tiers

### Tier 0: Disabled Tools (Soft Isolation)

Keep `find_thread` and `read_thread` disabled via `enabledTools` whitelist. This prevents cross-thread data access at the tool level.

**Current implementation**: Already done in `src/index.ts`.

**Limitation**: Relies on tool whitelist enforcement, not a security boundary.

### Tier 1: Sprites Sandbox (Per-Thread Isolation)

**Problem**: Single shared `WORKSPACE_DIR` means threads can read/write each other's files. Any filesystem isolation without hardware boundaries can be escaped via `Bash`.

**Solution**: Use [Sprites](https://sprites.dev) - persistent, hardware-isolated Linux VMs with:
- Firecracker microVMs (hardware-level isolation)
- Persistent ext4 filesystem that survives hibernation
- Fast wake from idle (<1s cold start)
- Network egress policy (allowlist domains)
- Pay only for active compute (~$0.44 for a 4-hour session)

#### Architecture: One Sprite per Slack Thread

```
Slack Thread (thread_ts)  →  Sprite (jane-{hash})  →  Amp Thread
         ↓                          ↓                      ↓
   User messages            Isolated filesystem      Conversation memory
   in one thread            persists across turns    persists across turns
```

Each Slack thread gets its own Sprite. The Sprite:
- Has Amp CLI pre-installed (from base image or checkpoint)
- Runs as non-root user
- Has network restricted to LLM APIs only
- Filesystem isolated from other users' Sprites

```typescript
import { SpritesClient } from './sprites-client.js'

const sprites = new SpritesClient(process.env.SPRITES_API_KEY!)

// Sprite naming: deterministic from Slack thread
function getSpriteName(channelId: string, threadTs: string): string {
  const hash = crypto.createHash('sha256')
    .update(`${channelId}:${threadTs}`)
    .digest('hex')
    .slice(0, 12)
  return `jane-${hash}`
}

async function getOrCreateSprite(channelId: string, threadTs: string): Promise<string> {
  const name = getSpriteName(channelId, threadTs)
  
  try {
    await sprites.get(name)
    return name
  } catch (e) {
    // Create from base checkpoint with Amp pre-installed
    await sprites.create(name)
    // Apply network policy (only allow LLM APIs)
    await sprites.updateNetworkPolicy(name, {
      allowList: ['api.anthropic.com', 'api.openai.com', 'ampcode.com']
    })
    return name
  }
}

async function runAmpInSprite(
  spriteName: string,
  prompt: string,
  ampThreadId: string | undefined
): Promise<{ content: string; threadId: string }> {
  const continueFlag = ampThreadId ? `--continue ${ampThreadId}` : ''
  
  // Execute amp CLI inside the Sprite
  const result = await sprites.exec(spriteName, [
    'amp', 'run',
    '--prompt', JSON.stringify(prompt),
    '--output', 'json',
    continueFlag
  ].filter(Boolean))
  
  // Parse JSON output for thread ID and result
  const output = JSON.parse(result.stdout)
  return {
    content: output.result,
    threadId: output.threadId
  }
}
```

#### Sprite Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    Sprite Lifecycle                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  First message in Slack thread:                             │
│    1. Create Sprite (jane-{hash})                           │
│    2. Apply network policy                                  │
│    3. Execute amp CLI                                       │
│    4. Sprite hibernates after idle timeout                  │
│                                                              │
│  Subsequent messages:                                        │
│    1. Wake Sprite (<1s)                                     │
│    2. Execute amp CLI with --continue                       │
│    3. Sprite hibernates again                               │
│                                                              │
│  Cleanup (cron job):                                         │
│    - Delete Sprites inactive >7 days                         │
│    - Or keep indefinitely (storage is cheap: $0.03/GB/mo)   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### Cost Estimate

| Usage Pattern | Est. Cost |
|---------------|-----------|
| Single request (30s active) | ~$0.01 |
| 10-message thread (5 min active) | ~$0.05 |
| Heavy user (20 threads/day, 2 hr active) | ~$0.25/day |
| Storage (100 Sprites × 1GB × 30 days) | ~$0.08/month |

#### Network Policy

Restrict Sprites to only necessary egress:

```typescript
await sprites.updateNetworkPolicy(spriteName, {
  allowList: [
    // LLM APIs
    'api.anthropic.com',
    'api.openai.com', 
    'ampcode.com',
    // Package managers (if needed)
    'registry.npmjs.org',
    'pypi.org',
    // MCP servers (if remote)
    // 'your-mcp-server.example.com'
  ]
})
```

#### Base Image / Checkpoint

Create a "golden" Sprite with Amp pre-installed, then checkpoint it:

```bash
# Create base sprite
sprite create jane-base

# Install amp CLI
sprite exec -s jane-base 'curl -fsSL https://ampcode.com/install.sh | bash'

# Create checkpoint
sprite checkpoint create -s jane-base --name amp-ready

# New sprites can restore from this checkpoint
sprite create jane-new --from jane-base:amp-ready
```

#### Alternative: Drop Bash entirely (simpler)

If users don't need shell access, disable `Bash` tool and skip Sprites:

```typescript
enabledTools: [
  // Filesystem tools (safe without Bash)
  "create_file", "edit_file", "Read", "glob", "Grep",
  // Analysis tools (safe)
  "finder", "librarian", "oracle", "mermaid",
  // Web tools (safe)
  "read_web_page", "web_search",
  // No Bash, no undo_edit, no Task
]
```

### Tier 2: Per-Thread Amp Tokens (Hard Thread Isolation)

**Problem**: Single Amp token cannot enforce thread-level access control. With one token, any Amp thread is accessible if you know/guess the ID.

**Solution**: Issue separate Amp access tokens per Slack thread (or accept soft isolation via disabled tools).

**Options**:

1. **Keep find_thread/read_thread disabled** (current approach) — threads are isolated by not exposing search tools
2. **Per-thread Amp tokens** — each Sprite gets its own Amp token, limiting thread visibility
3. **Policy proxy** — bot holds master token, mints scoped tokens per thread

For most use cases, option 1 (disabled tools) is sufficient since Sprites already provide filesystem isolation.

## MCP Isolation

### Current: Global MCP servers

All users share the same MCP server config, same credentials.

### Recommended: Per-channel/user MCP allowlists

```typescript
interface ChannelMcpConfig {
  allowedServers: string[]  // Which MCP servers this channel can use
}

const channelMcpAllowlists: Record<string, ChannelMcpConfig> = {
  'C0123456789': { allowedServers: ['buildkite', 'github'] },  // #eng channel
  'C0987654321': { allowedServers: ['linear'] },              // #product channel
  'default': { allowedServers: [] },                          // No MCP by default
}

function getMcpConfig(channelId: string): Record<string, McpServerConfig> {
  const allowed = channelMcpAllowlists[channelId]?.allowedServers 
    ?? channelMcpAllowlists.default.allowedServers
  
  return Object.fromEntries(
    Object.entries(config.mcpServers)
      .filter(([name]) => allowed.includes(name))
  )
}
```

## Rate Limiting

Prevent abuse by limiting requests per user:

```typescript
const userRateLimits = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(userId: string): boolean {
  const now = Date.now()
  const limit = userRateLimits.get(userId)
  
  if (!limit || now > limit.resetAt) {
    userRateLimits.set(userId, { count: 1, resetAt: now + 60_000 })
    return true
  }
  
  if (limit.count >= 10) {  // 10 requests per minute
    return false
  }
  
  limit.count++
  return true
}
```

## Recommended Implementation Order

| Priority | Task | Effort | Impact |
|----------|------|--------|--------|
| 1 | Sprites client + per-thread Sprites | M (4-8h) | Hard filesystem isolation |
| 2 | Network policy for Sprites | S (<1h) | Limits egress |
| 3 | Add rate limiting per user | S (<1h) | Prevents DoS |
| 4 | MCP server allowlists per channel | M (2-4h) | Limits blast radius |

## Decision Matrix

| Scenario | Recommended Tier |
|----------|------------------|
| Trusted team, no Bash | Tier 0 only (disabled tools) |
| Semi-trusted users, Bash enabled | Tier 1 (Sprites) |
| Untrusted users, public bot | Tier 1 (Sprites) + rate limiting |
| Compliance/SOC2 requirements | Tier 1 (Sprites) + Tier 2 (per-thread tokens) |

## Current janebot Status

- ✅ Thread tools disabled (find_thread, read_thread)
- ✅ Thread labels for privacy filtering
- ✅ Sprites client implemented (`src/sprites.ts`)
- ✅ Sprite pool for faster first-message latency (`src/sprite-pool.ts`)
- ✅ Amp runs inside Sprite with full tool access
- ✅ AMP_API_KEY passed to Sprite (security trade-off for simplicity)
- ⚠️ Global MCP config (not yet per-channel)
- ❌ No rate limiting

## Configuration

One execution environment must be configured (the bot will not start without one):

```bash
# Option 1: Sprites sandbox (recommended)
SPRITES_TOKEN=your-sprites-token  # Get from https://sprites.dev/account

# Option 2: Local execution (unsandboxed, for trusted single-user setups only)
ALLOW_LOCAL_EXECUTION=true
```

When `SPRITES_TOKEN` is set, each Slack thread gets its own isolated Sprite VM. Local execution requires explicit opt-in and provides no isolation.

## Next Steps

1. ✅ **Build Sprites client** (`src/sprites.ts`) - WebSocket exec API for long-running commands
2. ✅ **Sprite pool** (`src/sprite-pool.ts`) - Pre-warmed sprites for faster first-message latency (~6s vs ~20s)
3. ✅ **Checkpoints API** - Support for snapshot/restore (not currently used for pooling)
4. **Add rate limiting** - Token bucket per user
5. **MCP server allowlists per channel** - Limit tool access by channel
6. **LLM API proxy** - Keep AMP_API_KEY local instead of passing to Sprite
