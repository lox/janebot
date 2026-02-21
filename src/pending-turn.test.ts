import assert from "node:assert"
import { describe, it } from "node:test"
import { buildInitialPendingTurn } from "./pending-turn.js"

describe("buildInitialPendingTurn", () => {
  it("uses all debounced event timestamps as excluded thread history", () => {
    const turn = buildInitialPendingTurn({
      type: "mention",
      userId: "U123",
      message: "combined message",
      isInThread: true,
      fallbackEventTs: "1000.000001",
      eventTimestamps: ["1000.000001", "1000.000002", "1000.000003"],
    })

    assert.deepStrictEqual(turn.excludedHistoryEventTs, ["1000.000001", "1000.000002", "1000.000003"])
    assert.strictEqual(turn.eventTs, "1000.000003")
  })

  it("deduplicates event timestamps while preserving order", () => {
    const turn = buildInitialPendingTurn({
      type: "dm",
      userId: "U321",
      message: "combined message",
      isInThread: false,
      fallbackEventTs: "2000.000001",
      eventTimestamps: ["2000.000001", "2000.000001", "2000.000002"],
    })

    assert.deepStrictEqual(turn.eventTimestamps, ["2000.000001", "2000.000002"])
    assert.deepStrictEqual(turn.excludedHistoryEventTs, ["2000.000001", "2000.000002"])
  })
})
