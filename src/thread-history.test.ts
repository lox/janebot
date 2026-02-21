import assert from "node:assert"
import { describe, it } from "node:test"
import { formatThreadHistory, type ThreadHistoryMessage } from "./thread-history.js"

describe("formatThreadHistory", () => {
  it("keeps one prior message as valid thread context", () => {
    const messages: ThreadHistoryMessage[] = [
      {
        ts: "1000.000001",
        user: "U123",
        text: "Root instruction",
      },
    ]

    const history = formatThreadHistory({
      messages,
      botUserId: undefined,
      beforeTs: "1000.000002",
    })

    assert.strictEqual(history, "[U123]: Root instruction")
  })

  it("returns null for empty message arrays", () => {
    const history = formatThreadHistory({
      messages: [],
      botUserId: undefined,
      beforeTs: "1000.000002",
    })

    assert.strictEqual(history, null)
  })
})
