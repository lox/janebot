import { describe, it } from "node:test"
import assert from "node:assert"
import { cleanSlackMessage, formatErrorForUser, splitIntoChunks } from "./helpers.js"

describe("cleanSlackMessage", () => {
  it("converts Slack link format to backtick-wrapped label", () => {
    const result = cleanSlackMessage("Check </builds/123|builds/123> for details")
    assert.strictEqual(result, "Check `builds/123` for details")
  })

  it("passes through text without Slack links unchanged", () => {
    const result = cleanSlackMessage("plain text message")
    assert.strictEqual(result, "plain text message")
  })
})

describe("formatErrorForUser", () => {
  it("returns API key message for No API key errors", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("No API key found")),
      "I'm not configured properly. Please check the ANTHROPIC_API_KEY."
    )
  })

  it("returns API key message for missing Anthropic key errors", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("ANTHROPIC_API_KEY environment variable not set")),
      "I'm not configured properly. Please check the ANTHROPIC_API_KEY."
    )
  })

  it("returns auth message for invalid_auth errors", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("invalid_auth")),
      "Authentication failed. Please check the bot configuration."
    )
  })

  it("returns rate limit message", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("rate limit exceeded")),
      "I'm being rate limited. Please try again in a moment."
    )
  })

  it("returns timeout message", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("request timed out")),
      "The request timed out. Try a simpler task or try again."
    )
  })

  it("returns generic message for unknown errors", () => {
    assert.strictEqual(
      formatErrorForUser(new Error("kaboom")),
      "Something went wrong. Please try again."
    )
  })

  it("handles plain strings", () => {
    assert.strictEqual(
      formatErrorForUser("No API key"),
      "I'm not configured properly. Please check the ANTHROPIC_API_KEY."
    )
  })
})

describe("splitIntoChunks", () => {
  it("returns single chunk for short content", () => {
    const result = splitIntoChunks("short message")
    assert.deepStrictEqual(result, ["short message"])
  })

  it("splits at paragraph boundaries", () => {
    const para1 = "a".repeat(2000)
    const para2 = "b".repeat(2000)
    const content = `${para1}\n\n${para2}`
    const result = splitIntoChunks(content)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0], para1)
    assert.strictEqual(result[1], para2)
  })

  it("splits at line boundaries when no paragraph break", () => {
    const line1 = "a".repeat(2000)
    const line2 = "b".repeat(2000)
    const content = `${line1}\n${line2}`
    const result = splitIntoChunks(content)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0], line1)
    assert.strictEqual(result[1], line2)
  })
})
