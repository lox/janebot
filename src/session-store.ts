import { mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { dirname } from "node:path"
import * as log from "./logger.js"

export type PersistedSessionStatus = "idle" | "running" | "error"

export interface PersistedSubagentSession {
  id: string
  key: string
  channelId: string
  threadTs: string
  sandboxName: string
  piSessionFile: string
  status: PersistedSessionStatus
  runningJobId?: string
  lastJobId?: string
  lastError?: string
  turns: number
  createdAt: number
  updatedAt: number
}

interface Migration {
  version: number
  description: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Create subagent sessions table",
    sql: `
      CREATE TABLE IF NOT EXISTS subagent_sessions (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        sprite_name TEXT NOT NULL,
        pi_session_file TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')),
        running_job_id TEXT,
        last_job_id TEXT,
        last_error TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subagent_sessions_updated_at
        ON subagent_sessions(updated_at);
    `,
  },
]

type SessionRow = {
  id: string
  thread_key: string
  channel_id: string
  thread_ts: string
  sprite_name: string
  pi_session_file: string
  status: PersistedSessionStatus
  running_job_id: string | null
  last_job_id: string | null
  last_error: string | null
  turns: number
  created_at: number
  updated_at: number
}

export class SessionStore {
  readonly dbPath: string
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)

    // WAL mode improves write durability during crashes without heavy fsync costs.
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA synchronous = NORMAL;")
    this.db.exec("PRAGMA foreign_keys = ON;")

    this.applyMigrations()
  }

  close(): void {
    this.db.close()
  }

  getById(id: string): PersistedSubagentSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM subagent_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined
    return row ? mapRow(row) : undefined
  }

  getByThread(channelId: string, threadTs: string): PersistedSubagentSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM subagent_sessions WHERE channel_id = ? AND thread_ts = ?")
      .get(channelId, threadTs) as SessionRow | undefined
    return row ? mapRow(row) : undefined
  }

  upsert(session: PersistedSubagentSession): void {
    this.db
      .prepare(`
        INSERT INTO subagent_sessions (
          id,
          thread_key,
          channel_id,
          thread_ts,
          sprite_name,
          pi_session_file,
          status,
          running_job_id,
          last_job_id,
          last_error,
          turns,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          thread_key = excluded.thread_key,
          channel_id = excluded.channel_id,
          thread_ts = excluded.thread_ts,
          sprite_name = excluded.sprite_name,
          pi_session_file = excluded.pi_session_file,
          status = excluded.status,
          running_job_id = excluded.running_job_id,
          last_job_id = excluded.last_job_id,
          last_error = excluded.last_error,
          turns = excluded.turns,
          updated_at = excluded.updated_at
      `)
      .run(
        session.id,
        session.key,
        session.channelId,
        session.threadTs,
        session.sandboxName,
        session.piSessionFile,
        session.status,
        session.runningJobId ?? null,
        session.lastJobId ?? null,
        session.lastError ?? null,
        session.turns,
        session.createdAt,
        session.updatedAt,
      )
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `)

    const appliedRows = this.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number }>
    const applied = new Set(appliedRows.map((row) => row.version))

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue

      this.db.exec("BEGIN")
      try {
        this.db.exec(migration.sql)
        this.db
          .prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.description, Date.now())
        this.db.exec("COMMIT")
        log.info("Applied SQLite migration", {
          version: migration.version,
          description: migration.description,
        })
      } catch (err) {
        this.db.exec("ROLLBACK")
        throw err
      }
    }
  }
}

let store: SessionStore | undefined

export function initSessionStore(dbPath: string): SessionStore {
  if (store) {
    if (store.dbPath !== dbPath) {
      log.warn("Session store already initialised with different path", {
        existingPath: store.dbPath,
        requestedPath: dbPath,
      })
    }
    return store
  }

  store = new SessionStore(dbPath)
  log.info("SQLite session store ready", { path: dbPath })
  return store
}

export function getSessionStore(): SessionStore {
  if (!store) {
    throw new Error("Session store not initialised")
  }
  return store
}

function mapRow(row: SessionRow): PersistedSubagentSession {
  return {
    id: row.id,
    key: row.thread_key,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    sandboxName: row.sprite_name,
    piSessionFile: row.pi_session_file,
    status: row.status,
    runningJobId: row.running_job_id ?? undefined,
    lastJobId: row.last_job_id ?? undefined,
    lastError: row.last_error ?? undefined,
    turns: row.turns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
