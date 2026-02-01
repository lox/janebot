#!/usr/bin/env npx tsx
/**
 * REPL for testing janebot without Slack.
 *
 * Simulates a DM conversation with the bot, using the same execution
 * path as the real Slack handler.
 *
 * Usage:
 *   pnpm repl                    # Interactive mode
 *   pnpm repl --local            # Force local execution
 *   pnpm repl -x "your prompt"   # Execute single prompt and exit
 */

import "dotenv/config"
import * as readline from "readline"
import {
  execute,
  type ResultMessage,
  type ErrorResultMessage,
} from "@sourcegraph/amp-sdk"
import { config } from "../src/config.js"
import { executeInSprite, type GeneratedFile } from "../src/sprite-executor.js"
import * as sessions from "../src/sessions.js"
import { SpritesClient } from "../src/sprites.js"
import * as spritePool from "../src/sprite-pool.js"

// Fake user/channel IDs for the session
const FAKE_USER_ID = "U_REPL_USER"
const FAKE_CHANNEL_ID = "D_REPL"
let threadTs = Date.now().toString()

// Track conversation
let messageCount = 0

// Tools enabled for local execution
const LOCAL_ENABLED_TOOLS = [
  "Bash",
  "create_file",
  "edit_file",
  "finder",
  "glob",
  "Grep",
  "librarian",
  "look_at",
  "mermaid",
  "oracle",
  "Read",
  "read_web_page",
  "skill",
  "Task",
  "undo_edit",
  "web_search",
  "painter",
]

function buildSystemPrompt(userId: string): string {
  return `
## Current Context
- User ID: ${userId}
- Environment: REPL (CLI testing mode)

## Notes
This is a test environment. Respond naturally and concisely.
`
}

async function runAmpLocal(
  prompt: string,
  existingThreadId: string | undefined
): Promise<{ content: string; threadId: string | undefined }> {
  const messages = execute({
    prompt,
    options: {
      cwd: config.workspaceDir,
      mode: config.agentMode,
      mcpConfig:
        Object.keys(config.mcpServers).length > 0 ? config.mcpServers : undefined,
      continue: existingThreadId ?? false,
      systemPrompt: buildSystemPrompt(FAKE_USER_ID),
      labels: [`repl-${FAKE_USER_ID}`],
      permissions: [{ tool: "*", action: "allow" }],
      enabledTools: LOCAL_ENABLED_TOOLS,
      logLevel: "warn",
    },
  })

  let threadId: string | undefined
  let content = ""

  for await (const message of messages) {
    if ("session_id" in message && message.session_id) {
      threadId = message.session_id
    }

    if (message.type === "result") {
      if ((message as ResultMessage).subtype === "success") {
        content = (message as ResultMessage).result
      } else {
        const errorMsg = message as ErrorResultMessage
        throw new Error(errorMsg.error ?? "Execution failed")
      }
    }
  }

  return { content, threadId }
}

async function runAmpInSprite(
  prompt: string
): Promise<{ content: string; threadId: string | undefined; generatedFiles: GeneratedFile[]; spriteName: string }> {
  const result = await executeInSprite({
    channelId: FAKE_CHANNEL_ID,
    threadTs: threadTs,
    userId: FAKE_USER_ID,
    prompt,
    systemPrompt: buildSystemPrompt(FAKE_USER_ID),
  })
  return {
    content: result.content,
    threadId: result.threadId,
    generatedFiles: result.generatedFiles,
    spriteName: result.spriteName,
  }
}

async function handleMessage(input: string, forceLocal: boolean, quiet = false): Promise<string> {
  const startTime = Date.now()
  messageCount++

  try {
    let result: { content: string; threadId: string | undefined; generatedFiles?: GeneratedFile[]; spriteName?: string }

    // Get existing session
    const existingSession = sessions.get(FAKE_CHANNEL_ID, threadTs)

    if (config.spritesToken && !forceLocal) {
      if (!quiet) console.log("\x1b[90m  [Using Sprite sandbox...]\x1b[0m")
      result = await runAmpInSprite(input)
    } else {
      if (!quiet) console.log("\x1b[90m  [Using local execution...]\x1b[0m")
      result = await runAmpLocal(input, existingSession?.ampThreadId)

      // Store session for local mode
      if (result.threadId) {
        sessions.set(FAKE_CHANNEL_ID, threadTs, result.threadId, FAKE_USER_ID)
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    if (!quiet) console.log(`\x1b[90m  [Completed in ${duration}s]\x1b[0m`)

    // Show generated files info
    if (result.generatedFiles && result.generatedFiles.length > 0) {
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

function parseArgs(): {
  forceLocal: boolean
  executePrompt: string | null
  threadId: string | null
} {
  const args = process.argv.slice(2)
  let forceLocal = false
  let executePrompt: string | null = null
  let threadId: string | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--local") {
      forceLocal = true
    } else if (arg === "-x" && i + 1 < args.length) {
      executePrompt = args[i + 1]
      i++
    } else if (arg === "-t" && i + 1 < args.length) {
      threadId = args[i + 1]
      i++
    }
  }

  return { forceLocal, executePrompt, threadId }
}

async function runOnce(
  prompt: string,
  forceLocal: boolean,
  specifiedThreadId: string | null
): Promise<void> {
  // Check env first
  if (!process.env.AMP_API_KEY) {
    console.error("ERROR: AMP_API_KEY is required")
    process.exit(1)
  }

  if (!config.spritesToken && !config.allowLocalExecution) {
    console.error("ERROR: Set SPRITES_TOKEN or ALLOW_LOCAL_EXECUTION=true")
    process.exit(1)
  }

  // Use specified thread ID or generate new one
  if (specifiedThreadId) {
    threadTs = specifiedThreadId
  }

  // Load sessions
  sessions.load()

  // Initialize sprite pool if using sprites
  if (config.spritesToken && !forceLocal) {
    const client = new SpritesClient(config.spritesToken)
    await spritePool.initPool(client, 1) // Keep 1 warm sprite for REPL
  }

  const mode = config.spritesToken && !forceLocal ? "sprite" : "local"
  console.log(`\x1b[90m[Executing in ${mode} mode...]\x1b[0m`)
  console.log(`\x1b[90m[Thread: ${threadTs}]\x1b[0m`)
  console.log(`\x1b[90m[Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}]\x1b[0m\n`)

  const response = await handleMessage(prompt, forceLocal, false)

  console.log()
  console.log(response)

  // Output thread ID for subsequent calls
  console.log(`\n\x1b[90m[Thread ID for -t flag: ${threadTs}]\x1b[0m`)
}

async function runInteractive(forceLocal: boolean): Promise<void> {
  console.log("\n\x1b[1m=== janebot REPL ===\x1b[0m")
  console.log("Interactive testing mode")
  console.log()

  // Check required env vars
  console.log("Environment check:")
  console.log(`  AMP_API_KEY: ${process.env.AMP_API_KEY ? "✓ set" : "✗ NOT SET"}`)
  console.log(`  SPRITES_TOKEN: ${process.env.SPRITES_TOKEN ? "✓ set" : "✗ not set"}`)
  console.log(`  ALLOW_LOCAL_EXECUTION: ${process.env.ALLOW_LOCAL_EXECUTION || "not set"}`)
  console.log()

  if (!process.env.AMP_API_KEY) {
    console.log("\x1b[31mERROR: AMP_API_KEY is required. Set it in .env\x1b[0m\n")
    process.exit(1)
  }

  if (!config.spritesToken && !config.allowLocalExecution) {
    console.log("\x1b[33mWarning: Neither SPRITES_TOKEN nor ALLOW_LOCAL_EXECUTION is set.\x1b[0m")
    console.log("Set ALLOW_LOCAL_EXECUTION=true in .env for local testing.\n")
  }

  if (forceLocal) {
    console.log("\x1b[33m--local flag: Forcing local execution\x1b[0m\n")
  } else if (config.spritesToken) {
    console.log(`\x1b[32mUsing Sprites sandbox\x1b[0m`)
    console.log(`Thread: ${FAKE_CHANNEL_ID}:${threadTs}\n`)
  } else {
    console.log("\x1b[32mUsing local execution\x1b[0m\n")
  }

  console.log("Type your messages below. Commands:")
  console.log("  /quit or /exit  - Exit")
  console.log("  /clear          - Start fresh thread")
  console.log("  /status         - Show current session info")
  console.log()

  // Load sessions
  sessions.load()

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

      // Handle commands
      if (trimmed === "/quit" || trimmed === "/exit") {
        console.log("\nGoodbye!")
        rl.close()
        process.exit(0)
      }

      if (trimmed === "/clear") {
        threadTs = Date.now().toString()
        messageCount = 0
        console.log(`\x1b[90m  [Thread cleared. New thread: ${threadTs}]\x1b[0m\n`)
        prompt()
        return
      }

      if (trimmed === "/status") {
        const session = sessions.get(FAKE_CHANNEL_ID, threadTs)
        console.log("\x1b[90m  Session info:\x1b[0m")
        console.log(`    Channel: ${FAKE_CHANNEL_ID}`)
        console.log(`    Thread: ${threadTs}`)
        console.log(`    Amp Thread: ${session?.ampThreadId || "(none)"}`)
        console.log(`    Sprite: ${session?.spriteName || "(none)"}`)
        console.log(`    Messages: ${messageCount}`)
        console.log()
        prompt()
        return
      }

      // Process message
      console.log()
      const response = await handleMessage(trimmed, forceLocal)

      // Display response
      console.log()
      console.log("\x1b[35mJane:\x1b[0m", response)
      console.log()

      prompt()
    })
  }

  prompt()
}

async function main() {
  const { forceLocal, executePrompt, threadId } = parseArgs()

  if (executePrompt) {
    await runOnce(executePrompt, forceLocal, threadId)
  } else {
    await runInteractive(forceLocal)
  }
}

main().catch((error) => {
  console.error("Fatal error:", error)
  process.exit(1)
})
