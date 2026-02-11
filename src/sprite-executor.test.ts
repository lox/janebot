import { describe, it } from "node:test"
import assert from "node:assert"
import { parseAmpOutput } from "./sprite-executor.js"

describe("parseAmpOutput", () => {
  it("returns empty content and no threadId for empty output", () => {
    const result = parseAmpOutput("")
    assert.strictEqual(result.content, "")
    assert.strictEqual(result.threadId, undefined)
    assert.deepStrictEqual(result.generatedFiles, [])
  })

  it("extracts content and threadId from success result", () => {
    const output = [
      JSON.stringify({ type: "system", session_id: "T-abc123" }),
      JSON.stringify({ type: "result", subtype: "success", result: "Hello world", session_id: "T-abc123" }),
    ].join("\n")
    const result = parseAmpOutput(output)
    assert.strictEqual(result.content, "Hello world")
    assert.strictEqual(result.threadId, "T-abc123")
  })

  it("throws on error result", () => {
    const output = JSON.stringify({ type: "result", is_error: true, error: "something failed" })
    assert.throws(() => parseAmpOutput(output), { message: "something failed" })
  })

  it("extracts generatedFiles from painter tool_use", () => {
    const output = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "painter", input: { savePath: "/tmp/img.png" } },
        ],
      },
    })
    const result = parseAmpOutput(output)
    assert.strictEqual(result.generatedFiles.length, 1)
    assert.strictEqual(result.generatedFiles[0].path, "/tmp/img.png")
    assert.strictEqual(result.generatedFiles[0].filename, "img.png")
  })

  it("extracts generatedFiles with data from image tool_result", () => {
    const output = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [
              { type: "image", savedPath: "/tmp/img.png", data: "aGVsbG8=" },
            ],
          },
        ],
      },
    })
    const result = parseAmpOutput(output)
    assert.strictEqual(result.generatedFiles.length, 1)
    assert.strictEqual(result.generatedFiles[0].path, "/tmp/img.png")
    assert.ok(result.generatedFiles[0].data instanceof Buffer)
  })

  it("skips non-JSON lines without error", () => {
    const output = "not json\n" + JSON.stringify({ type: "system", session_id: "T-xyz" }) + "\nmore garbage"
    const result = parseAmpOutput(output)
    assert.strictEqual(result.threadId, "T-xyz")
  })
})
