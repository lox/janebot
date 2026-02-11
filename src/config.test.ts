import { describe, it, beforeEach } from "node:test"
import assert from "node:assert"
import { config, isUserAllowed, isChannelAllowed } from "./config.js"

describe("isUserAllowed", () => {
  beforeEach(() => {
    config.allowedUserIds = []
  })

  it("returns true when allowedUserIds is empty", () => {
    assert.strictEqual(isUserAllowed("U123"), true)
  })

  it("returns true when userId is in the list", () => {
    config.allowedUserIds = ["U123", "U456"]
    assert.strictEqual(isUserAllowed("U123"), true)
  })

  it("returns false when userId is not in the list", () => {
    config.allowedUserIds = ["U123", "U456"]
    assert.strictEqual(isUserAllowed("U999"), false)
  })
})

describe("isChannelAllowed", () => {
  beforeEach(() => {
    config.allowedChannelIds = []
  })

  it("returns true when allowedChannelIds is empty", () => {
    assert.strictEqual(isChannelAllowed("C123"), true)
  })

  it("returns true when channelId is in the list", () => {
    config.allowedChannelIds = ["C123", "C456"]
    assert.strictEqual(isChannelAllowed("C123"), true)
  })

  it("returns false when channelId is not in the list", () => {
    config.allowedChannelIds = ["C123", "C456"]
    assert.strictEqual(isChannelAllowed("C999"), false)
  })
})

describe("config shape", () => {
  it("has expected properties", () => {
    assert.ok(typeof config.workspaceDir === "string")
    assert.ok(Array.isArray(config.allowedUserIds))
    assert.ok(Array.isArray(config.allowedChannelIds))
    assert.ok(typeof config.mcpServers === "object")
    assert.ok(typeof config.debounceMs === "number")
  })
})
