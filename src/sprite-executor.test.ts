import { describe, it } from "node:test"
import assert from "node:assert"
import { parsePiOutput } from "./sprite-executor.js"

describe("parsePiOutput", () => {
  it("extracts content from agent_end messages", () => {
    const output = [
      JSON.stringify({ type: "session", version: 3, id: "test-session" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant", model: "claude-opus-4-6", content: [] } }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "Hello world" }], model: "claude-opus-4-6" },
        ],
      }),
    ].join("\n")
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "Hello world")
    assert.strictEqual(result.model, "claude-opus-4-6")
  })

  it("throws when no agent_end event present", () => {
    const output = [
      JSON.stringify({ type: "session", version: 3, id: "test-session" }),
      JSON.stringify({ type: "agent_start" }),
    ].join("\n")
    assert.throws(() => parsePiOutput(output), { message: /no agent_end event/ })
  })

  it("returns empty content when agent_end has no assistant text", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    })
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "")
  })

  it("extracts model from first assistant message_start", () => {
    const output = [
      JSON.stringify({ type: "message_start", message: { role: "assistant", model: "gpt-4o", content: [] } }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "done" }], model: "gpt-4o" },
        ],
      }),
    ].join("\n")
    const result = parsePiOutput(output)
    assert.strictEqual(result.model, "gpt-4o")
  })

  it("joins multiple text parts in assistant message", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Part one" },
            { type: "text", text: "Part two" },
          ],
        },
      ],
    })
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "Part one\nPart two")
  })

  it("uses the last assistant message when multiple exist", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "First response" }] },
        { role: "user", content: [{ type: "text", text: "follow up" }] },
        { role: "assistant", content: [{ type: "text", text: "Final response" }] },
      ],
    })
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "Final response")
  })

  it("skips non-JSON lines without error", () => {
    const output = "not json\n" +
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }) +
      "\nmore garbage"
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "ok")
  })

  it("returns empty content for empty output", () => {
    assert.throws(() => parsePiOutput(""), { message: /no agent_end event/ })
  })

  it("ignores unknown event types gracefully", () => {
    const output = [
      JSON.stringify({ type: "unknown_future_event", data: "whatever" }),
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "works" }] }] }),
    ].join("\n")
    const result = parsePiOutput(output)
    assert.strictEqual(result.content, "works")
  })
})
