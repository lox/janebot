# Session Store (SQLite)

janebot persists coding subagent session metadata in SQLite so subagent sessions can be resumed across process restarts.

## Startup and migrations

At process startup, `main()` calls `initSessionStore(config.sessionDbPath)`.

Migration behavior is defined in `src/session-store.ts`:

1. Open/create the SQLite file at `SESSION_DB_PATH` (or default path).
2. Ensure `schema_migrations` exists.
3. Apply pending migrations in version order inside transactions.
4. Record each successful migration in `schema_migrations`.

This migration runner is idempotent. Restarting janebot does not re-apply completed migrations.

## Schema

### `schema_migrations`

Tracks applied schema versions.

| Column | Type | Notes |
|---|---|---|
| `version` | `INTEGER` | Primary key |
| `description` | `TEXT` | Human-readable migration description |
| `applied_at` | `INTEGER` | Unix epoch millis |

### `subagent_sessions`

Persistent mapping for thread-to-subagent identity and runtime state.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | Primary key (`sa_<hash>`) |
| `thread_key` | `TEXT` | Unique (`<channel_id>:<thread_ts>`) |
| `channel_id` | `TEXT` | Slack channel id |
| `thread_ts` | `TEXT` | Slack thread timestamp |
| `sandbox_name` | `TEXT` | Deterministic sandbox name |
| `pi_session_file` | `TEXT` | Pi JSONL session file path in sandbox |
| `status` | `TEXT` | `idle`, `running`, or `error` |
| `running_job_id` | `TEXT` | Active job id, nullable |
| `last_job_id` | `TEXT` | Most recent completed/attempted job id |
| `last_error` | `TEXT` | Last error string, nullable |
| `turns` | `INTEGER` | Completed turn count |
| `created_at` | `INTEGER` | Unix epoch millis |
| `updated_at` | `INTEGER` | Unix epoch millis |

Indexes:

- Unique index on `thread_key`
- Non-unique index on `updated_at`

## What is persisted

`runCodingSubagent` now persists session state transitions:

- session creation
- `running` state on dispatch
- `idle` state on completion
- `error` state on failure
- `idle` state on abort

On restart, lookups by thread id or `subagentSessionId` can hydrate from SQLite and continue the same session metadata.
