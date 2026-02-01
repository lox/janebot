# Thread Model

Jane uses [Amp threads](https://ampcode.com/news/thread-labels) to maintain conversation continuity and enable cross-conversation search.

## How It Works

```
Slack Thread (thread_ts)  →  Amp Thread (session_id)
         ↓                           ↓
   User messages              Conversation memory
   in one thread              persists across turns
```

Each Slack thread maps to an Amp thread. When a user continues a conversation in the same Slack thread, Jane resumes the same Amp thread—preserving context from previous messages.

## Thread Labels

Every thread is labeled with:
- `slack-user:{userId}` — the Slack user who started the conversation

This enables:
- Searching past conversations with `find_thread`
- Reading context from previous threads with `read_thread`
- Privacy-scoped queries (Jane filters by user label for "my threads")

## Privacy Model

| Thread Type | Who Can Search |
|-------------|---------------|
| DM threads | Only the user who created them (via label filter) |
| Public/workspace threads | Anyone (Amp's default visibility) |

Jane is instructed via system prompt to:
1. Filter "my threads" queries by the current user's label
2. Allow searching public/workspace-visible threads freely
3. Not access threads labeled with other user IDs

This is "soft" isolation—Jane follows the rules by convention. For hard isolation, you'd need per-user Amp tokens.

## Session Storage

Currently in-memory (`Map<slackThreadKey, ampThreadId>`). Sessions are lost on restart.

**Future**: Persist to SQLite or JSON file (see [PLAN.md](../PLAN.md) Phase 4).

## Tools Available

Jane can use these Amp tools for thread operations:

- **`find_thread`** — Search threads by keywords or file changes
- **`read_thread`** — Read content from a thread by ID

Example queries Jane can handle:
- "Find my threads about the database migration"
- "What did we discuss last time about auth?"
- "Read the thread where we set up the API"
