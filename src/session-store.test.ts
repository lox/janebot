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

    assert.strictEqual(row.count, 1)
  })
})
