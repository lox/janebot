#!/usr/bin/env npx tsx
/**
 * Integration test: janebot → sandbox backend → Pi → response.
 *
 * Tests the full execution path without Slack. Creates a temporary sandbox,
 * installs Pi, runs a prompt, verifies output parsing, and cleans up.
 *
 * Usage:
 *   pnpm test:sandbox                             # Default test prompt
 *   pnpm test:sandbox "What is 2+2?"              # Custom prompt
 *   pnpm test:sandbox --with-artifacts            # Test artifact creation
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"
import { parsePiOutput } from "../src/pi-output.js"

const PI_VERSION = "0.52.9"
const SANDBOX_PATH =
  "/.sprite/languages/node/nvm/versions/node/v22.20.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

async function main() {
  const args = process.argv.slice(2)
  const withArtifacts = args.includes("--with-artifacts")
  const customPrompt = args.filter((a) => !a.startsWith("--")).join(" ")

  const prompt =
    customPrompt ||
    (withArtifacts
      ? "Write a haiku about coding to /home/sprite/artifacts/haiku.txt. Then tell me what you wrote."
      : "What is 2+2? Reply with just the number.")

  console.log("=== Pi Sandbox Integration Test ===\n")

  const sandboxToken = process.env.SPRITES_TOKEN
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!sandboxToken) {
    console.error("ERROR: Sandbox token (SPRITES_TOKEN) not set")
    process.exit(1)
  }
  if (!anthropicKey) {
    console.error("ERROR: ANTHROPIC_API_KEY not set")
    process.exit(1)
  }

  console.log("✓ Sandbox token (SPRITES_TOKEN) set")
  console.log("✓ ANTHROPIC_API_KEY set")
  console.log()

  const client = new SpritesClient(sandboxToken)
  const sandboxName = "jane-test-" + Date.now().toString(36)

  try {
    // Phase 1: Create sandbox
    let phaseStart = Date.now()
    console.log(`Creating sandbox: ${sandboxName}`)
    await client.create(sandboxName)
    console.log(`✓ Sandbox created (${ms(phaseStart)})`)

    // Phase 2: Set network policy
    phaseStart = Date.now()
    await client.setNetworkPolicy(sandboxName, [
      { action: "allow", domain: "registry.npmjs.org" },
      { action: "allow", domain: "*.npmjs.org" },
      { action: "allow", domain: "*.npmjs.com" },
      { action: "allow", domain: "api.anthropic.com" },
      { action: "allow", domain: "api.openai.com" },
      { action: "allow", domain: "*.googleapis.com" },
      { action: "allow", domain: "*.cloudflare.com" },
    ])
    console.log(`✓ Network policy set (${ms(phaseStart)})`)

    // Phase 3: Install Pi
    phaseStart = Date.now()
    console.log(`\nInstalling Pi v${PI_VERSION}...`)
    const installResult = await client.exec(
      sandboxName,
      [
        "bash",
        "-c",
        `npm install -g @mariozechner/pi-coding-agent@${PI_VERSION}`,
      ],
      { timeoutMs: 180000 }
    )

    if (installResult.exitCode !== 0) {
      console.error("Pi install failed:", installResult.stderr)
      throw new Error("Pi install failed")
    }

    // Find Pi binary
    const prefixResult = await client.exec(
      sandboxName,
      ["bash", "-c", "npm prefix -g"],
      { timeoutMs: 10000 }
    )
    const piBin = `${prefixResult.stdout.trim()}/bin/pi`

    const versionResult = await client.exec(sandboxName, [piBin, "--version"], {
      timeoutMs: 10000,
    })
    console.log(
      `✓ Pi ${versionResult.stdout.trim()} installed (${ms(phaseStart)})`
    )

    // Phase 4: Write AGENTS.md
    phaseStart = Date.now()
    await client.exec(
      sandboxName,
      [
        "bash",
        "-c",
        `printf '%s' 'You are a helpful assistant. Keep responses very short.' > /home/sprite/AGENTS.md`,
      ],
      { timeoutMs: 10000 }
    )
    console.log(`✓ AGENTS.md written (${ms(phaseStart)})`)

    // Phase 5: Clean artifacts dir
    await client.exec(
      sandboxName,
      [
        "bash",
        "-c",
        "rm -rf /home/sprite/artifacts && mkdir -p /home/sprite/artifacts",
      ],
      { timeoutMs: 10000 }
    )

    // Phase 6: Execute Pi
    const env: Record<string, string> = {
      PATH: SANDBOX_PATH,
      HOME: "/home/sprite",
      NO_COLOR: "1",
      TERM: "dumb",
      CI: "true",
      ANTHROPIC_API_KEY: anthropicKey,
    }

    console.log(`\n=== Executing Pi ===`)
    console.log(`Prompt: ${prompt}`)
    console.log()

    phaseStart = Date.now()
    const result = await client.exec(
      sandboxName,
      [piBin, "--mode", "json", "--no-session"],
      {
        env,
        stdin: prompt + "\n",
        timeoutMs: 120000,
      }
    )
    const execDuration = ms(phaseStart)

    console.log(`Exit code: ${result.exitCode}`)
    if (result.stderr) {
      console.log(`Stderr: ${result.stderr.slice(0, 500)}`)
    }

    // Phase 7: Parse output
    try {
      const parsed = parsePiOutput(result.stdout)
      console.log(`\n=== Result (${execDuration}) ===`)
      console.log(`Model: ${parsed.model || "(unknown)"}`)
      console.log(`Content: ${parsed.content.slice(0, 500)}`)

      if (!parsed.content) {
        console.warn("\n⚠ Empty content — dumping raw stdout:")
        console.log(result.stdout.slice(0, 2000))
      }
    } catch (err) {
      console.error(
        `\n✗ Parse failed: ${err instanceof Error ? err.message : err}`
      )
      console.log("\nRaw stdout (first 2000 chars):")
      console.log(result.stdout.slice(0, 2000))
    }

    // Phase 8: Check artifacts
    const artifactResult = await client.exec(
      sandboxName,
      ["find", "/home/sprite/artifacts", "-type", "f", "-maxdepth", "2"],
      { timeoutMs: 10000 }
    )
    const artifacts = artifactResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean)

    if (artifacts.length > 0) {
      console.log(`\n=== Artifacts (${artifacts.length}) ===`)
      for (const a of artifacts) {
        console.log(`  ${a}`)
      }
    } else if (withArtifacts) {
      console.warn("\n⚠ No artifacts found (expected with --with-artifacts)")
    }

    // Cleanup
    console.log(`\nCleaning up sandbox...`)
    await client.delete(sandboxName)
    console.log("✓ Done")
  } catch (error) {
    console.error("\nERROR:", error)
    try {
      await client.delete(sandboxName)
      console.log("(Sandbox cleaned up)")
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1)
  }
}

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`
}

main()
