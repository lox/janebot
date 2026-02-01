/**
 * Execute Amp inside a Sprite sandbox.
 *
 * This provides per-thread isolation by running the amp CLI
 * inside a dedicated Sprite VM for each Slack thread.
 *
 * Security note: AMP_API_KEY is passed to the Sprite. This is a trade-off
 * for simplicity - the Sprite could theoretically access Amp APIs directly.
 * Future iteration could proxy the LLM API to keep the key local.
 */

import { SpritesClient } from "./sprites.js"
import { config } from "./config.js"
import * as log from "./logger.js"
import * as sessions from "./sessions.js"
import * as pool from "./sprite-pool.js"

// Cache of sprites that have amp installed (in-memory, rebuilt on restart)
const ampInstalledSprites = new Set<string>()

const AMP_BIN = "/home/sprite/.amp/bin/amp"

/**
 * JSON message from amp --stream-json output.
 */
interface AmpStreamMessage {
  type: "system" | "assistant" | "user" | "result"
  session_id: string
  subtype?: "init" | "success" | "error_during_execution" | "error_max_turns"
  result?: string
  error?: string
  is_error?: boolean
}

/**
 * Ensure amp CLI is installed in a Sprite.
 */
async function ensureAmpInstalled(
  client: SpritesClient,
  spriteName: string
): Promise<void> {
  if (ampInstalledSprites.has(spriteName)) {
    return
  }

  const check = await client.exec(spriteName, [
    "bash",
    "-c",
    `${AMP_BIN} --version 2>/dev/null || echo "NOT_INSTALLED"`,
  ])

  if (!check.stdout.includes("NOT_INSTALLED")) {
    ampInstalledSprites.add(spriteName)
    log.info("Amp CLI already installed", { sprite: spriteName })
    return
  }

  log.info("Installing amp CLI in sprite", { sprite: spriteName })
  await client.exec(spriteName, [
    "bash",
    "-c",
    "curl -fsSL https://ampcode.com/install.sh | bash",
  ])

  ampInstalledSprites.add(spriteName)
  log.info("Amp CLI installed", { sprite: spriteName })
}

export interface SpriteExecutorOptions {
  channelId: string
  threadTs: string
  userId: string
  prompt: string
  systemPrompt?: string
}

export interface SpriteExecutorResult {
  content: string
  threadId: string | undefined
  spriteName: string
}

/**
 * Parse amp --stream-json output to extract session_id and result.
 */
function parseAmpOutput(stdout: string): {
  threadId: string | undefined
  content: string
} {
  let threadId: string | undefined
  let content = ""
  let errorMsg: string | undefined

  const lines = stdout.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    try {
      const msg: AmpStreamMessage = JSON.parse(line)

      if (msg.session_id) {
        threadId = msg.session_id
      }

      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.result) {
          content = msg.result
        } else if (msg.is_error && msg.error) {
          errorMsg = msg.error
        }
      }
    } catch {
      // Non-JSON line - skip
    }
  }

  if (errorMsg && !content) {
    throw new Error(errorMsg)
  }

  return { threadId, content }
}

/**
 * Execute an Amp prompt inside a Sprite sandbox.
 */
export async function executeInSprite(
  options: SpriteExecutorOptions
): Promise<SpriteExecutorResult> {
  const token = config.spritesToken
  if (!token) {
    throw new Error("SPRITES_TOKEN not configured")
  }

  const client = new SpritesClient(token)
  const threadKey = `${options.channelId}:${options.threadTs}`

  // Check if this thread already has a sprite (from session or pool)
  const existingSession = sessions.get(options.channelId, options.threadTs)
  let spriteName: string

  if (existingSession?.spriteName) {
    // Reuse existing sprite for this thread
    spriteName = existingSession.spriteName
    const sprite = await client.get(spriteName)
    log.info("Using existing sprite", { sprite: spriteName, status: sprite?.status ?? "unknown" })
  } else {
    // Try to claim a pre-warmed sprite from the pool
    const poolSprite = pool.claimSprite(threadKey)

    if (poolSprite) {
      // Use pool sprite - amp is already installed
      spriteName = poolSprite
      ampInstalledSprites.add(spriteName)
      log.info("Using pool sprite", { sprite: spriteName })
    } else {
      // Fall back to creating a new sprite
      const sprite = await client.getOrCreate(options.channelId, options.threadTs)
      spriteName = sprite.name
      log.info("Created new sprite", { sprite: spriteName, status: sprite.status })
    }
  }

  // Ensure amp is installed (no-op if already installed or from pool)
  await ensureAmpInstalled(client, spriteName)

  // Write system prompt to file if provided (amp CLI reads from file)
  const systemPromptFile = "/tmp/system-prompt.md"
  if (options.systemPrompt) {
    await client.exec(spriteName, [
      "bash",
      "-c",
      `cat > ${systemPromptFile}`,
    ], { stdin: options.systemPrompt })
  }

  // Build CLI args: amp [threads continue <id>] --execute --stream-json [options]
  const args: string[] = [AMP_BIN]

  if (existingSession?.ampThreadId) {
    args.push("threads", "continue", existingSession.ampThreadId)
  }

  args.push("--execute", "--stream-json")
  args.push("--dangerously-allow-all")
  args.push("--mode", config.agentMode)
  args.push("--log-level", "warn")

  if (options.systemPrompt) {
    args.push("--system-prompt-file", systemPromptFile)
  }

  // Environment for amp
  const env: Record<string, string> = {
    PATH: `/home/sprite/.amp/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/home/sprite",
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "true",
  }

  const ampApiKey = process.env.AMP_API_KEY
  if (!ampApiKey) {
    throw new Error("AMP_API_KEY environment variable not set")
  }
  // SECURITY NOTE: AMP_API_KEY is passed via Sprites exec API query params.
  // This may be logged by infrastructure. Use a dedicated, least-privileged key.
  // Future: proxy LLM API calls locally to avoid exposing the key to sprites.
  env.AMP_API_KEY = ampApiKey

  log.info("Executing amp in sprite", {
    sprite: spriteName,
    hasExistingThread: !!existingSession?.ampThreadId,
    args: args.join(" "),
  })

  // Execute via WebSocket, send prompt on stdin
  const result = await client.exec(spriteName, args, {
    env,
    stdin: options.prompt + "\n",
    timeoutMs: 300000, // 5 minutes
  })

  // Parse JSON output
  const { threadId, content } = parseAmpOutput(result.stdout)

  // Store session for thread continuity
  if (threadId) {
    sessions.set(
      options.channelId,
      options.threadTs,
      threadId,
      options.userId,
      spriteName
    )
    log.info("Session stored", {
      slack: `${options.channelId}:${options.threadTs}`,
      ampThread: threadId,
    })
  }

  return {
    content: content || "Done.",
    threadId,
    spriteName,
  }
}
