import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, it } from "node:test"
import { SessionStore, type PersistedSubagentSession } from "./session-store.js"

describe("SessionStore", () => {
  let tempDir = ""
  let dbPath = ""
  let store: SessionStore | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "janebot-session-store-"))
    dbPath = join(tempDir, "state.sqlite")
  })

  afterEach(() => {
    store?.close()
    store = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("persists and reloads subagent sessions", () => {
    store = new SessionStore(dbPath)

    const session: PersistedSubagentSession = {
      id: "sa_123",
      key: "C123:1234.567",
      channelId: "C123",
      threadTs: "1234.567",
      sandboxName: "jane-abc",
      piSessionFile: "/home/sprite/sessions/sa_123.jsonl",
      status: "idle",
      turns: 0,
      createdAt: 10,
      updatedAt: 10,
    }

    store.upsert(session)

    const byThread = store.getByThread("C123", "1234.567")
    assert.ok(byThread)
    assert.strictEqual(byThread.id, "sa_123")
    assert.strictEqual(byThread.status, "idle")

    store.upsert({
      ...session,
      status: "running",
      runningJobId: "job_1",
      turns: 3,
      updatedAt: 20,
    })

    const byId = store.getById("sa_123")
    assert.ok(byId)
    assert.strictEqual(byId.status, "running")
    assert.strictEqual(byId.runningJobId, "job_1")
    assert.strictEqual(byId.turns, 3)
    assert.strictEqual(byId.updatedAt, 20)
  })

  it("applies migrations only once", () => {
    const first = new SessionStore(dbPath)
    first.close()

    const second = new SessionStore(dbPath)
    second.close()

    const db = new DatabaseSync(dbPath)
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number }
    db.close()

    assert.strictEqual(row.count, 2)
  })

  it("renames legacy sprite_name column to sandbox_name", () => {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

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
    `)
    db
      .prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)")
      .run(1, "Create subagent sessions table", Date.now())
    db
      .prepare(`
        INSERT INTO subagent_sessions (
          id,
          thread_key,
          channel_id,
          thread_ts,
          sprite_name,
          pi_session_file,
          status,
          turns,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "sa_legacy",
        "C1:1.23",
        "C1",
        "1.23",
        "jane-legacy",
        "/home/sprite/sessions/sa_legacy.jsonl",
        "idle",
        0,
        100,
        100,
      )
    db.close()

    store = new SessionStore(dbPath)
    const legacy = store.getById("sa_legacy")
    assert.ok(legacy)
    assert.strictEqual(legacy.sandboxName, "jane-legacy")

    const verify = new DatabaseSync(dbPath)
    const columns = verify
      .prepare("PRAGMA table_info(subagent_sessions)")
      .all() as Array<{ name: string }>
    verify.close()

    assert.ok(columns.some((column) => column.name === "sandbox_name"))
    assert.ok(!columns.some((column) => column.name === "sprite_name"))
  })
})
