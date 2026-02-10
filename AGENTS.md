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
- `src/sprites.ts` - Sprites API client for sandboxed execution
- `src/sprite-runners.ts` - Runner pool: N sprites with checkpoint/restore for clean state between requests
- `src/sprite-executor.ts` - Executes Amp inside a runner sprite
- Uses Amp SDK `execute()` for local execution, or Sprites for sandboxed execution

## Key Patterns

1. **Stateless execution**: Each message gets a fresh Amp session. Slack thread history is fetched each time as context (including Jane's own replies). No persistent sessions or Amp thread continuation.
2. **Runner pool with checkpoint/restore**: N sprites are initialised with amp installed and checkpointed. Each request acquires a runner, executes, then restores to the clean checkpoint. This gives fast startup with clean state.
3. **Message debouncing**: Combines rapid messages into a single prompt
4. **Chunked responses**: Split long responses for Slack's 4000 char limit
5. **Visual feedback**: React with 👀 (processing), ✅ (done), ❌ (error)
6. **Authorization**: User and channel allowlists via env vars
