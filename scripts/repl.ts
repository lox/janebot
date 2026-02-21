#!/usr/bin/env npx tsx
/**
 * REPL for testing janebot without Slack.
 *
 * Uses the same thread runtime codepath as Slack handling:
 * runThreadTurn + runControlCommand.
 *
 * Usage:
 *   pnpm repl                    # Interactive mode
 *   pnpm repl -x "your prompt"   # Execute single prompt and exit
 */

import "dotenv/config"
import * as readline from "readline"
import { config } from "../src/config.js"
import { hasOrchestratorSession } from "../src/orchestrator.js"
import { initSandboxClient, type SandboxClient } from "../src/sandbox.js"
import { initSessionStore } from "../src/session-store.js"
import { SpritesClient } from "../src/sprites.js"
import { DockerSandboxClient } from "../src/docker-sandbox.js"
import { extractControlCommand, runControlCommand, runThreadTurn } from "../src/thread-runtime.js"

const FAKE_USER_ID = "U_REPL_USER"
const FAKE_CHANNEL_ID = "D_REPL"

let threadTs = Date.now().toString()
let messageCount = 0
let runtimeInitPromise: Promise<void> | undefined

function createSandboxClient(): SandboxClient {
  if (config.sandboxBackend === "docker") {
    return new DockerSandboxClient()
  }

  if (!config.spritesToken) {
    throw new Error("SPRITES_TOKEN is required when SANDBOX_BACKEND=sprites")
  }

  return new SpritesClient(config.spritesToken)
}

function validateConfig(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required")
  }
  if (config.sandboxBackend === "sprites" && !config.spritesToken) {
    throw new Error("SPRITES_TOKEN is required when SANDBOX_BACKEND=sprites")
  }
}

async function ensureRuntimeInitialized(): Promise<void> {
  if (runtimeInitPromise) {
    await runtimeInitPromise
    return
  }

  runtimeInitPromise = (async () => {
    validateConfig()
    initSessionStore(config.sessionDbPath)
    initSandboxClient(createSandboxClient())
  })()

  try {
    await runtimeInitPromise
  } catch (error) {
    runtimeInitPromise = undefined
    throw error
  }
}

async function handleMessage(input: string, quiet = false): Promise<string> {
  await ensureRuntimeInitialized()
  const startTime = Date.now()
  messageCount++

  try {
    if (!quiet) console.log("\x1b[90m  [Running thread turn...]\x1b[0m")
    const result = await runThreadTurn({
      channelId: FAKE_CHANNEL_ID,
      threadTs,
      userId: FAKE_USER_ID,
      eventTs: Date.now().toString(),
      message: input,
      progressCallback: async (message) => {
        if (!quiet) {
          console.log(`\x1b[90m  ${message}\x1b[0m`)
        }
      },
    })

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    if (!quiet) console.log(`\x1b[90m  [Completed in ${duration}s]\x1b[0m`)

    if (result.generatedFiles.length > 0) {
      console.log(`\x1b[90m  [Generated ${result.generatedFiles.length} file(s):]\x1b[0m`)
      for (const file of result.generatedFiles) {
        console.log(`\x1b[90m    - ${file.path}\x1b[0m`)
      }
    }

    return result.content
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `❌ Error: ${message}`
  }
}

function parseArgs(): { executePrompt: string | null } {
  const args = process.argv.slice(2)
  let executePrompt: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--local") {
      throw new Error("--local has been removed. Use SANDBOX_BACKEND=docker (default) or SANDBOX_BACKEND=sprites.")
    }
    if (arg === "-x" && i + 1 < args.length) {
      executePrompt = args[i + 1]
      i++
    }
  }

  return { executePrompt }
}

async function runOnce(prompt: string): Promise<void> {
  await ensureRuntimeInitialized()

  console.log(`\x1b[90m[Executing REPL thread (${config.sandboxBackend})...]\x1b[0m`)
  console.log(`\x1b[90m[Thread: ${FAKE_CHANNEL_ID}:${threadTs}]\x1b[0m`)
  console.log(`\x1b[90m[Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}]\x1b[0m\n`)

  const command = extractControlCommand(prompt)
  if (command) {
    try {
      const result = await runControlCommand(command, FAKE_CHANNEL_ID, threadTs)
      console.log(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`❌ Error: ${message}`)
    }
    return
  }

  const response = await handleMessage(prompt, false)
  console.log()
  console.log(response)
}

async function runInteractive(): Promise<void> {
  console.log("\n\x1b[1m=== janebot REPL ===\x1b[0m")
  console.log("Interactive testing mode")
  console.log()

  console.log("Environment check:")
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "✓ set" : "✗ NOT SET"}`)
  console.log(`  SANDBOX_BACKEND: ${config.sandboxBackend}`)
  if (config.sandboxBackend === "sprites") {
    console.log(`  SPRITES_TOKEN: ${process.env.SPRITES_TOKEN ? "✓ set" : "✗ NOT SET"}`)
  }
  console.log()

  try {
    await ensureRuntimeInitialized()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`\x1b[31mERROR: ${message}\x1b[0m\n`)
    process.exit(1)
  }

  console.log(`\x1b[32mUsing shared thread runtime (${config.sandboxBackend})\x1b[0m`)
  console.log(`\x1b[90mThread: ${FAKE_CHANNEL_ID}:${threadTs}\x1b[0m\n`)

  console.log("Type your messages below. Commands:")
  console.log("  /quit or /exit  - Exit")
  console.log("  /clear          - Start fresh thread")
  console.log("  /status         - Show orchestrator/subagent status")
  console.log("  /abort          - Abort active subagent run")
  console.log()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = () => {
    rl.question("\x1b[36mYou:\x1b[0m ", async (input) => {
      const trimmed = input.trim()

      if (!trimmed) {
        prompt()
        return
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        console.log("\nGoodbye!")
        rl.close()
        process.exit(0)
      }

      if (trimmed === "/clear") {
        threadTs = Date.now().toString()
        messageCount = 0
        console.log(`\x1b[90m  [Thread cleared. New thread: ${FAKE_CHANNEL_ID}:${threadTs}]\x1b[0m\n`)
        prompt()
        return
      }

      const command = extractControlCommand(trimmed)
      if (command) {
        try {
          const result = await runControlCommand(command, FAKE_CHANNEL_ID, threadTs)
          if (command === "status") {
            const orchestratorExists = hasOrchestratorSession(FAKE_CHANNEL_ID, threadTs)
            console.log(`\x1b[90m  Thread: ${FAKE_CHANNEL_ID}:${threadTs}\x1b[0m`)
            console.log(`\x1b[90m  Orchestrator session: ${orchestratorExists ? "active" : "not created"}\x1b[0m`)
            console.log(`\x1b[90m  Subagent: ${result}\x1b[0m`)
            console.log(`\x1b[90m  Messages: ${messageCount}\x1b[0m`)
          } else {
            console.log(`\x1b[90m  ${result}\x1b[0m`)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.log(`\x1b[90m  ❌ Error: ${message}\x1b[0m`)
        }
        console.log()
        prompt()
        return
      }

      console.log()
      const response = await handleMessage(trimmed)

      console.log()
      console.log("\x1b[35mJane:\x1b[0m", response)
      console.log()

      prompt()
    })
  }

  prompt()
}

async function main() {
  const { executePrompt } = parseArgs()

  if (executePrompt) {
    await runOnce(executePrompt)
  } else {
    await runInteractive()
  }
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
