# Thread Model

Jane uses a **persistent subagent session model**.

## How It Works

```
Slack Thread (channel + thread_ts)  →  Subagent Session ID (sa_xxx)  →  Dedicated Sprite
```

When a user sends a message in a Slack thread, Jane:
1. Continues the thread's host orchestrator Pi session
2. The orchestrator decides whether to delegate coding via `run_coding_subagent`
3. Delegated work runs in the same long-lived Pi session in that thread's Sprite
4. Jane returns the synthesized result back to Slack

## Why Persistent Sessions?

The previous stateless model reset execution state every turn. That improved isolation but hurt responsiveness and deep iterative coding workflows.

The new model keeps coding context alive per thread, which improves:
- Turn-to-turn speed
- Ability to iterate over multi-step code changes
- Continuity of repo state, test results, and tool context

## Control Commands

Inside a Slack thread:
- `/status` shows current subagent state and IDs
- `/abort` requests that the running Pi process is stopped

## Session Identity

Each Slack thread maps to:
- a stable host orchestrator session
- a stable `subagent_session_id` and Sprite name derived from `(channel_id, thread_ts)`

This enables follow-up messages to continue the same coding session without replaying full thread history each turn.
