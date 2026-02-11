process.env.DEBOUNCE_MS = "50"

import { describe, it } from "node:test"
import assert from "node:assert"
import { debounce, hasPending, cancel } from "./debouncer.js"

describe("debounce", () => {
  it("resolves with a single message", async () => {
    const result = await debounce("single-1", "hello")
    assert.strictEqual(result, "hello")
  })

  it("combines multiple messages with same key", async () => {
    const p1 = debounce("multi-1", "first")
    const p2 = debounce("multi-1", "second")
    const [r1, r2] = await Promise.all([p1, p2])
    assert.strictEqual(r1, "first\n\nsecond")
    assert.strictEqual(r2, "first\n\nsecond")
  })

  it("keeps different keys independent", async () => {
    const p1 = debounce("key-a", "alpha")
    const p2 = debounce("key-b", "beta")
    const [r1, r2] = await Promise.all([p1, p2])
    assert.strictEqual(r1, "alpha")
    assert.strictEqual(r2, "beta")
  })

  it("hasPending returns true while debouncing", async () => {
    const p = debounce("pending-1", "msg")
    assert.strictEqual(hasPending("pending-1"), true)
    await p
    assert.strictEqual(hasPending("pending-1"), false)
  })

  it("cancel clears pending messages", () => {
    debounce("cancel-1", "msg")
    assert.strictEqual(hasPending("cancel-1"), true)
    cancel("cancel-1")
    assert.strictEqual(hasPending("cancel-1"), false)
  })
})
