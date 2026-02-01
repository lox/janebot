#!/usr/bin/env npx tsx
/**
 * Test script for Sprites API integration.
 * Run with: npx tsx scripts/test-sprites.ts
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

const token = process.env.SPRITES_TOKEN
if (!token) {
  console.error("❌ SPRITES_TOKEN not set in .env")
  process.exit(1)
}

const client = new SpritesClient(token)

async function main() {
  console.log("🧪 Testing Sprites API...\n")

  // Test 1: Generate sprite name
  const testChannel = "C1234567890"
  const testThread = "1234567890.123456"
  const name = SpritesClient.getSpriteName(testChannel, testThread)
  console.log(`✓ Generated sprite name: ${name}`)

  // Test 2: List existing sprites
  console.log("\n📋 Listing existing jane-* sprites...")
  const existing = await client.list("jane-")
  console.log(`  Found ${existing.length} sprites`)
  for (const s of existing.slice(0, 5)) {
    console.log(`  - ${s.name} (${s.status})`)
  }
  if (existing.length > 5) {
    console.log(`  ... and ${existing.length - 5} more`)
  }

  // Test 3: Create a test sprite
  const testName = `jane-test-${Date.now().toString(36)}`
  console.log(`\n🚀 Creating test sprite: ${testName}`)
  const sprite = await client.create(testName)
  console.log(`  ✓ Created: ${sprite.name} (${sprite.status})`)
  console.log(`  URL: ${sprite.url}`)

  // Test 4: Set network policy (allow amp install + LLM APIs)
  console.log("\n🔒 Setting network policy...")
  await client.setNetworkPolicy(testName, [
    { action: "allow", domain: "ampcode.com" },
    { action: "allow", domain: "*.ampcode.com" },
    { action: "allow", domain: "storage.googleapis.com" },
    { action: "allow", domain: "api.anthropic.com" },
    { action: "allow", domain: "api.openai.com" },
  ])
  console.log("  ✓ Network policy applied")

  // Test 5: Execute a command
  console.log("\n⚡ Executing test command...")
  const result = await client.exec(testName, ["echo", "Hello from Sprite!"])
  console.log(`  stdout: ${result.stdout.trim()}`)
  console.log(`  exit code: ${result.exitCode}`)

  // Test 6: Install amp CLI
  console.log("\n📦 Installing amp CLI...")
  const installResult = await client.exec(testName, [
    "bash",
    "-c",
    "curl -fsSL https://ampcode.com/install.sh | bash",
  ])
  console.log("  Install output:", installResult.stdout.slice(0, 100) + "...")

  // Test 7: Verify amp installed
  const AMP_BIN = "/home/sprite/.amp/bin/amp"
  console.log("\n🔍 Verifying amp CLI...")
  const ampCheck = await client.exec(testName, [AMP_BIN, "--version"])
  console.log(`  ✓ amp version: ${ampCheck.stdout.trim()}`)

  // Test 8: Run a simple amp command (if AMP_API_KEY is set)
  if (process.env.AMP_API_KEY) {
    console.log("\n🤖 Testing amp execution...")
    const ampResult = await client.exec(
      testName,
      [AMP_BIN, "run", "--prompt", "Say hello in exactly 3 words", "--mode", "rush"],
      { env: { AMP_API_KEY: process.env.AMP_API_KEY } }
    )
    console.log(`  Response: ${ampResult.stdout.trim().slice(0, 200)}`)
  } else {
    console.log("\n⚠ Skipping amp execution test (AMP_API_KEY not set)")
  }

  // Test 9: Clean up test sprite
  console.log(`\n🧹 Deleting test sprite: ${testName}`)
  await client.delete(testName)
  console.log("  ✓ Deleted")

  console.log("\n✅ All tests passed!")
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message)
  process.exit(1)
})
