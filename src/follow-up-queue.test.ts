import assert from "node:assert"
import { afterEach, describe, it } from "node:test"
import {
  clearFollowUpQueue,
  drainFollowUpBatch,
  enqueueFollowUp,
  getFollowUpCount,
  isSteeringMessage,
  summarizeFollowUpBatch,
  type QueuedFollowUp,
} from "./follow-up-queue.js"

function makeMessage(overrides: Partial<QueuedFollowUp> = {}): QueuedFollowUp {
  return {
    type: "mention",
    userId: "U123",
    eventTs: "1000.000001",
    rawText: "hello",
    isInThread: true,
    ...overrides,
  }
}

describe("follow-up queue", () => {
  afterEach(() => {
    clearFollowUpQueue("thread-1")
    clearFollowUpQueue("thread-2")
  })

  it("retains queued follow-ups until they are drained", () => {
    enqueueFollowUp("thread-1", makeMessage({ rawText: "first" }))
    enqueueFollowUp("thread-1", makeMessage({ rawText: "second", eventTs: "1000.000002" }))

    assert.strictEqual(getFollowUpCount("thread-1"), 2)

    const batch = drainFollowUpBatch("thread-1")
    assert.strictEqual(batch.length, 2)
    assert.strictEqual(batch[0]?.rawText, "first")
    assert.strictEqual(batch[1]?.rawText, "second")
    assert.strictEqual(getFollowUpCount("thread-1"), 0)
  })

  it("steering message replaces earlier queued intent", () => {
    enqueueFollowUp("thread-2", makeMessage({ rawText: "Run tests" }))
    enqueueFollowUp("thread-2", makeMessage({ rawText: "actually, don't do that; update docs instead", eventTs: "1000.000003" }))

    const batch = drainFollowUpBatch("thread-2")
    assert.strictEqual(batch.length, 1)
    assert.strictEqual(batch[0]?.rawText, "actually, don't do that; update docs instead")
  })
})

describe("isSteeringMessage", () => {
  it("detects steering phrases", () => {
    assert.strictEqual(isSteeringMessage("actually do this instead"), true)
    assert.strictEqual(isSteeringMessage("ignore that and refactor this"), true)
    assert.strictEqual(isSteeringMessage("scratch that"), true)
  })

  it("does not flag normal prompts", () => {
    assert.strictEqual(isSteeringMessage("Please run the test suite"), false)
    assert.strictEqual(isSteeringMessage("This is actually correct"), false)
    assert.strictEqual(isSteeringMessage("I used npm instead of yarn"), false)
    assert.strictEqual(isSteeringMessage("don't stop believing"), false)
    assert.strictEqual(isSteeringMessage("please cancel the calendar event"), false)
  })
})

describe("summarizeFollowUpBatch", () => {
  it("returns per-message reaction timestamps and keeps thread history enabled", () => {
    const summary = summarizeFollowUpBatch([
      makeMessage({ rawText: "first", eventTs: "1000.000001" }),
      makeMessage({ rawText: "second", eventTs: "1000.000002" }),
      makeMessage({ rawText: "third", eventTs: "1000.000003" }),
    ])

    assert.ok(summary)
    assert.strictEqual(summary?.latestEventTs, "1000.000003")
    assert.deepStrictEqual(summary?.eventTimestamps, ["1000.000001", "1000.000002", "1000.000003"])
    assert.strictEqual(summary?.includeThreadHistory, true)
    assert.deepStrictEqual(summary?.excludedHistoryEventTs, ["1000.000001", "1000.000002", "1000.000003"])
  })

  it("returns undefined for empty batches", () => {
    const summary = summarizeFollowUpBatch([])
    assert.strictEqual(summary, undefined)
  })
})
