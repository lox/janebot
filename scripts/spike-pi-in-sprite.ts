#!/usr/bin/env npx tsx
/**
 * Spike: Test Pi coding agent inside a Sprite container.
 *
 * Validates:
 * 1. npm install -g works in a sprite
 * 2. Pi binary location after install
 * 3. Pi --mode json output format (exact JSONL schema)
 * 4. System prompt injection via AGENTS.md
 * 5. Stdout vs stderr separation
 * 6. Error output format
 *
 * Usage:
 *   mise exec node -- tsx scripts/spike-pi-in-sprite.ts
 *
 * Requires SPRITES_TOKEN and ANTHROPIC_API_KEY in env.
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

const SPRITE_NAME = "pi-spike-test"
const PI_VERSION = "0.52.9" // Pin version

async function main() {
  const spritesToken = process.env.SPRITES_TOKEN
  if (!spritesToken) {
    console.error("ERROR: SPRITES_TOKEN required")
    process.exit(1)
  }

  // Pi supports multiple providers — find whichever key is available
  const providerKeys: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  }

  const availableKeys = Object.entries(providerKeys).filter(([, v]) => v)
  if (availableKeys.length === 0) {
    console.error("ERROR: Need at least one LLM provider API key")
    console.error("Supported: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY")
    console.error("(AMP_API_KEY won't work — Pi needs direct provider keys)")
    process.exit(1)
  }

  console.log("Available provider keys:", availableKeys.map(([k]) => k).join(", "))

  const client = new SpritesClient(spritesToken)

  // Clean up any previous spike sprite
  const existing = await client.get(SPRITE_NAME)
  if (existing) {
    console.log("Deleting existing spike sprite...")
    await client.delete(SPRITE_NAME)
  }

  console.log("\n=== Creating sprite ===")
  await client.create(SPRITE_NAME)

  // Set network policy — need npm registry + LLM provider APIs
  await client.setNetworkPolicy(SPRITE_NAME, [
    // npm registry (for install)
    { action: "allow", domain: "registry.npmjs.org" },
    { action: "allow", domain: "*.npmjs.org" },
    { action: "allow", domain: "*.npmjs.com" },
    // LLM providers
    { action: "allow", domain: "api.anthropic.com" },
    { action: "allow", domain: "api.openai.com" },
    { action: "allow", domain: "generativelanguage.googleapis.com" },
    { action: "allow", domain: "*.googleapis.com" },
    { action: "allow", domain: "api.x.ai" },
    { action: "allow", domain: "openrouter.ai" },
    { action: "allow", domain: "*.openrouter.ai" },
    // GitHub (Pi may fetch models.dev or similar)
    { action: "allow", domain: "github.com" },
    { action: "allow", domain: "*.github.com" },
    { action: "allow", domain: "raw.githubusercontent.com" },
    // CDN
    { action: "allow", domain: "*.cloudflare.com" },
  ])

  // === Step 1: Install Pi ===
  console.log(`\n=== Installing Pi v${PI_VERSION} ===`)
  const installStart = Date.now()
  const installResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `npm install -g @mariozechner/pi-coding-agent@${PI_VERSION}`,
  ], { timeoutMs: 180000 })

  console.log(`Install exit code: ${installResult.exitCode}`)
  console.log(`Install time: ${((Date.now() - installStart) / 1000).toFixed(1)}s`)
  console.log("Install stdout (last 500):", installResult.stdout.slice(-500))
  if (installResult.stderr) {
    console.log("Install stderr (last 500):", installResult.stderr.slice(-500))
  }

  // Check if pi binary actually exists even if exit code is non-zero (npm warns can cause this)
  const checkInstall = await client.exec(SPRITE_NAME, [
    "bash", "-c", "ls -la $(npm prefix -g)/bin/pi 2>&1",
  ], { timeoutMs: 10000 })
  console.log("Pi binary check:", checkInstall.stdout.trim())
  if (checkInstall.exitCode !== 0) {
    console.error("Pi binary not found after install!")
    await client.delete(SPRITE_NAME)
    process.exit(1)
  }

  // === Step 2: Find Pi binary ===
  console.log("\n=== Finding Pi binary ===")

  // npm global prefix + find the pi binary
  const findResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `echo "npm prefix: $(npm prefix -g)" && \
     echo "PATH: $PATH" && \
     ls -la $(npm prefix -g)/bin/pi* 2>/dev/null || true && \
     find / -name "pi" -type f 2>/dev/null | grep -v proc | head -10`,
  ], { timeoutMs: 30000 })
  console.log(findResult.stdout)

  // Use npm prefix -g to find bin directory
  const prefixResult = await client.exec(SPRITE_NAME, [
    "bash", "-c", "npm prefix -g",
  ], { timeoutMs: 10000 })
  const npmPrefix = prefixResult.stdout.trim()
  const PI_BIN = `${npmPrefix}/bin/pi`
  console.log(`Using Pi binary: ${PI_BIN}`)

  const versionResult = await client.exec(SPRITE_NAME, [
    "bash", "-c", `${PI_BIN} --version 2>&1`,
  ], { timeoutMs: 10000 })
  console.log(`Pi version: ${versionResult.stdout.trim()}`)

  // === Step 3: Check available modes ===
  console.log("\n=== Checking Pi help ===")
  const helpResult = await client.exec(SPRITE_NAME, [
    "bash", "-c", `${PI_BIN} --help 2>&1`,
  ], { timeoutMs: 10000 })
  console.log("Help output (first 2000):")
  console.log(helpResult.stdout.slice(0, 2000))

  // === Step 4: Write AGENTS.md for system prompt ===
  console.log("\n=== Writing AGENTS.md ===")
  const agentsMd = `# System Prompt

You are a helpful assistant. Keep responses short and direct.
Respond in plain text, no markdown formatting.
`
  const writeResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `cat > /home/sprite/AGENTS.md << 'HEREDOC'
${agentsMd}
HEREDOC`,
  ], { timeoutMs: 10000 })
  console.log(`Write AGENTS.md exit code: ${writeResult.exitCode}`)

  // Also check what Pi reads — does it use CWD or HOME?
  const catResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    "echo HOME=$HOME && echo CWD=$(pwd) && cat /home/sprite/AGENTS.md",
  ], { timeoutMs: 10000 })
  console.log(catResult.stdout)

  // === Step 5: Run Pi with --mode json ===
  console.log("\n=== Running Pi --mode json (simple prompt) ===")

  // Get the sprite's default PATH so node/npm are available
  const pathResult = await client.exec(SPRITE_NAME, [
    "bash", "-c", "echo $PATH",
  ], { timeoutMs: 10000 })
  const spritePath = pathResult.stdout.trim()
  console.log(`Sprite PATH: ${spritePath}`)

  const env: Record<string, string> = {
    PATH: spritePath || `${npmPrefix}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/home/sprite",
    NO_COLOR: "1",
    TERM: "dumb",
  }

  // Pass all available provider keys to the sprite
  for (const [key, value] of availableKeys) {
    env[key] = value!
  }

  const piStart = Date.now()
  const piResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `${PI_BIN} --mode json --no-session "What is 2+2? Reply with just the number." 2>/tmp/pi-stderr.log; echo "---STDERR---"; cat /tmp/pi-stderr.log`,
  ], {
    env,
    timeoutMs: 120000,
  })
  const piTime = ((Date.now() - piStart) / 1000).toFixed(1)

  console.log(`\nPi exit code: ${piResult.exitCode}`)
  console.log(`Pi time: ${piTime}s`)
  console.log(`\n--- STDOUT (${piResult.stdout.length} bytes) ---`)
  console.log(piResult.stdout)
  console.log(`\n--- STDERR (${piResult.stderr.length} bytes) ---`)
  console.log(piResult.stderr.slice(0, 2000))

  // === Step 6: Parse the JSON output ===
  console.log("\n=== Parsing JSON output ===")
  const lines = piResult.stdout.split("\n").filter(l => l.trim())
  console.log(`Total lines: ${lines.length}`)

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i])
      console.log(`\nLine ${i}: type=${parsed.type}`)
      console.log(JSON.stringify(parsed, null, 2).slice(0, 1000))
    } catch {
      console.log(`\nLine ${i}: NOT JSON: ${lines[i].slice(0, 200)}`)
    }
  }

  // === Step 7: Test error case ===
  console.log("\n\n=== Running Pi with invalid model (error case) ===")
  const errorResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `${PI_BIN} --mode json --no-session --model anthropic/nonexistent-model "hello" 2>&1`,
  ], {
    env,
    timeoutMs: 30000,
  })

  console.log(`\nError case exit code: ${errorResult.exitCode}`)
  console.log(`--- STDOUT ---`)
  console.log(errorResult.stdout.slice(0, 1000))
  console.log(`--- STDERR ---`)
  console.log(errorResult.stderr.slice(0, 1000))

  // === Step 8: Test with tool use ===
  console.log("\n\n=== Running Pi with tool use (ls command) ===")
  const toolResult = await client.exec(SPRITE_NAME, [
    "bash", "-c",
    `${PI_BIN} --mode json --no-session "List the files in /home/sprite/ using ls. Just show the output." 2>/tmp/pi-stderr2.log; echo "---STDERR---"; cat /tmp/pi-stderr2.log`,
  ], {
    env,
    timeoutMs: 120000,
  })

  console.log(`\nTool use exit code: ${toolResult.exitCode}`)
  console.log(`--- STDOUT (${toolResult.stdout.length} bytes) ---`)

  const toolLines = toolResult.stdout.split("\n").filter(l => l.trim())
  console.log(`Total lines: ${toolLines.length}`)

  for (let i = 0; i < toolLines.length; i++) {
    try {
      const parsed = JSON.parse(toolLines[i])
      console.log(`\nLine ${i}: type=${parsed.type}`)
      // Truncate large tool results
      const str = JSON.stringify(parsed, null, 2)
      console.log(str.slice(0, 800) + (str.length > 800 ? "\n  ... (truncated)" : ""))
    } catch {
      console.log(`\nLine ${i}: NOT JSON: ${toolLines[i].slice(0, 200)}`)
    }
  }

  console.log(`\n--- STDERR ---`)
  console.log(toolResult.stderr.slice(0, 1000))

  // === Cleanup ===
  console.log("\n\n=== Cleanup ===")
  await client.delete(SPRITE_NAME)
  console.log("Spike sprite deleted.")

  console.log("\n=== SPIKE COMPLETE ===")
  console.log(`Pi binary location: ${PI_BIN}`)
  console.log(`Install time: ${((Date.now() - installStart) / 1000).toFixed(0)}s (one-time, baked into checkpoint)`)
}

main().catch((err) => {
  console.error("Spike failed:", err)
  process.exit(1)
})
