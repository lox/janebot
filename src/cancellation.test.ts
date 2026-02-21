import assert from "node:assert"
import { describe, it } from "node:test"
import { isExpectedCancellationError } from "./cancellation.js"

describe("isExpectedCancellationError", () => {
  it("does not treat generic cancellation-like runtime errors as expected", () => {
    assert.strictEqual(isExpectedCancellationError(new Error("request canceled by upstream service")), false)
    assert.strictEqual(isExpectedCancellationError(new Error("job aborted due to timeout")), false)
  })

  it("does not treat generic AbortError as expected", () => {
    const error = new Error("The operation was aborted due to network timeout")
    error.name = "AbortError"
    assert.strictEqual(isExpectedCancellationError(error), false)
  })

  it("only treats explicit user-abort errors as expected", () => {
    const error = Object.assign(new Error("User requested abort"), { code: "JANE_USER_ABORT" })
    assert.strictEqual(isExpectedCancellationError(error), true)
  })
})
