# AGENTS.md - janebot

## Overview

janebot is a Slack bot powered by the Amp SDK. It responds to @mentions and DMs.

## Build & Run

```bash
mise exec node -- pnpm install      # Install dependencies
mise exec node -- pnpm dev          # Run with hot reload
mise exec node -- pnpm build        # Build for production
mise exec node -- pnpm typecheck    # Type check
```

## Architecture

- `src/index.ts` - Main entry point, Slack event handlers
- `src/config.ts` - Configuration loading from environment
- `src/debouncer.ts` - Message debouncing for rapid messages
- `src/sessions.ts` - Persistent session store (Slack thread → Amp thread + Sprite)
- `src/sprites.ts` - Sprites API client for sandboxed execution
- `src/sprite-executor.ts` - Executes Amp inside Sprite VMs
- `src/slack-mcp.ts` - Slack MCP server for Sprites (see [docs/slack-mcp.md](docs/slack-mcp.md))
- Uses Amp SDK `execute()` for local execution, or Sprites for sandboxed execution

## Key Patterns

1. **Thread mapping**: Each Slack thread maps to an Amp thread for continuity (see [docs/threads.md](docs/threads.md))
2. **Message debouncing**: Combines rapid messages into a single prompt
3. **Chunked responses**: Split long responses for Slack's 4000 char limit
4. **Visual feedback**: React with 👀 (processing), ✅ (done), ❌ (error)
5. **Authorization**: User and channel allowlists via env vars
6. **Thread labels**: Each thread labeled with `slack-user:{userId}` for privacy-scoped search
