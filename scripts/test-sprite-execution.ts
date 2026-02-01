#!/usr/bin/env npx tsx
/**
 * Test script for Sprite execution without Slack.
 *
 * Usage:
 *   pnpm test:sprite "Run ls -la and tell me what you see"
 *   pnpm test:sprite "Create a file called hello.txt with 'Hello World'"
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

const AMP_BIN = "/home/sprite/.amp/bin/amp"

interface AmpStreamMessage {
  type: "system" | "assistant" | "user" | "result"
  session_id: string
  subtype?: "init" | "success" | "error_during_execution" | "error_max_turns"
  result?: string
  error?: string
  is_error?: boolean
}

function parseAmpOutput(stdout: string): {
  threadId: string | undefined
  content: string
  rawLines: string[]
} {
  let threadId: string | undefined
  let content = ""
  const rawLines: string[] = []

  const lines = stdout.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    rawLines.push(line)
    try {
      const msg: AmpStreamMessage = JSON.parse(line)

      if (msg.session_id) {
        threadId = msg.session_id
      }

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.result) {
          content = msg.result
        } else if (msg.is_error && msg.error) {
          content = `ERROR: ${msg.error}`
        }
      }
    } catch {
      // Non-JSON line
      console.log("  [non-json]", line.slice(0, 100))
    }
  }

  return { threadId, content, rawLines }
}

async function main() {
  const prompt = process.argv.slice(2).join(" ") || "Run 'echo hello' and show me the output"

  console.log("=== Sprite Execution Test ===\n")

  // Check required env vars
  const spritesToken = process.env.SPRITES_TOKEN
  const ampApiKey = process.env.AMP_API_KEY

  if (!spritesToken) {
    console.error("ERROR: SPRITES_TOKEN not set")
    process.exit(1)
  }
  if (!ampApiKey) {
    console.error("ERROR: AMP_API_KEY not set")
    process.exit(1)
  }

  console.log("✓ SPRITES_TOKEN set")
  console.log("✓ AMP_API_KEY set")
  console.log()

  const client = new SpritesClient(spritesToken)

  // Use a test sprite name
  const spriteName = "jane-test-" + Date.now().toString(36)

  try {
    // Create sprite
    console.log(`Creating sprite: ${spriteName}`)
    const sprite = await client.create(spriteName)
    console.log(`✓ Sprite created: ${sprite.name} (status: ${sprite.status})`)

    // Set network policy
    console.log("Setting network policy...")
    await client.setNetworkPolicy(spriteName, [
      { action: "allow", domain: "ampcode.com" },
      { action: "allow", domain: "*.ampcode.com" },
      { action: "allow", domain: "storage.googleapis.com" },
      { action: "allow", domain: "api.anthropic.com" },
      { action: "allow", domain: "api.openai.com" },
    ])
    console.log("✓ Network policy set")

    // Check if amp is installed
    console.log("\nChecking amp installation...")
    const check = await client.exec(spriteName, [
      "bash",
      "-c",
      `${AMP_BIN} --version 2>/dev/null || echo "NOT_INSTALLED"`,
    ])

    if (check.stdout.includes("NOT_INSTALLED")) {
      console.log("Installing amp CLI...")
      const install = await client.exec(spriteName, [
        "bash",
        "-c",
        "curl -fsSL https://ampcode.com/install.sh | bash",
      ])
      console.log("Install output:", install.stdout.slice(0, 200))
    } else {
      console.log(`✓ Amp already installed: ${check.stdout.trim()}`)
    }

    // Build amp command
    const args: string[] = [
      AMP_BIN,
      "--execute",
      "--stream-json",
      "--dangerously-allow-all",
      "--mode",
      "smart",
      "--log-level",
      "warn",
    ]

    const env: Record<string, string> = {
      PATH: `/home/sprite/.amp/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/home/sprite",
      NO_COLOR: "1",
      TERM: "dumb",
      CI: "true",
      AMP_API_KEY: ampApiKey,
    }

    console.log("\n=== Executing Amp ===")
    console.log("Prompt:", prompt)
    console.log("Args:", args.slice(1).join(" "))
    console.log("Env keys:", Object.keys(env).join(", "))
    console.log()

    const startTime = Date.now()
    const result = await client.exec(spriteName, args, {
      env,
      stdin: prompt + "\n",
      timeoutMs: 120000,
    })
    const duration = Date.now() - startTime

    console.log(`\n=== Result (${duration}ms) ===`)
    console.log("Exit code:", result.exitCode)
    console.log("Stderr:", result.stderr || "(empty)")
    console.log()

    // Parse output
    const parsed = parseAmpOutput(result.stdout)

    console.log("=== Parsed Output ===")
    console.log("Thread ID:", parsed.threadId || "(none)")
    console.log("Content:", parsed.content || "(empty)")
    console.log()

    if (!parsed.content && !parsed.threadId) {
      console.log("=== Raw stdout ===")
      console.log(result.stdout.slice(0, 2000))
    }

    // Cleanup
    console.log("\nCleaning up sprite...")
    await client.delete(spriteName)
    console.log("✓ Sprite deleted")

  } catch (error) {
    console.error("\nERROR:", error)

    // Try to cleanup
    try {
      await client.delete(spriteName)
      console.log("(Sprite cleaned up)")
    } catch {
      // Ignore cleanup errors
    }

    process.exit(1)
  }
}

main()
