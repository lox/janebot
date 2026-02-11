import "dotenv/config"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { App, LogLevel } from "@slack/bolt"
import {
  execute,
  type StreamMessage,
  type ResultMessage,
  type ErrorResultMessage,
} from "@sourcegraph/amp-sdk"
import { config, isUserAllowed, isChannelAllowed } from "./config.js"
import { debounce, cancel } from "./debouncer.js"
import { markdownToSlack } from "md-to-slack"
import * as log from "./logger.js"
import { executeInSprite, type GeneratedFile } from "./sprite-executor.js"
import { SpritesClient } from "./sprites.js"
import { initRunners } from "./sprite-runners.js"
import { cleanSlackMessage, formatErrorForUser, splitIntoChunks } from "./helpers.js"

// Load SOUL.md for Jane's personality
const __dirname = dirname(fileURLToPath(import.meta.url))
const soulPath = join(__dirname, "..", "SOUL.md")
let soulPrompt = ""
try {
  soulPrompt = readFileSync(soulPath, "utf-8")
} catch {
  // SOUL.md is optional
}



// Track in-flight requests to prevent duplicate processing
const inFlight = new Set<string>()

// Initialize Slack app in Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
})

// Cache bot user ID to avoid repeated auth.test() calls
let cachedBotUserId: string | undefined

async function getBotUserId(client: typeof app.client): Promise<string | undefined> {
  if (cachedBotUserId) return cachedBotUserId
  const authTest = await client.auth.test()
  cachedBotUserId = authTest.user_id
  return cachedBotUserId
}

async function fetchThreadContext(
  client: typeof app.client,
  channel: string,
  threadTs: string,
  botUserId: string | undefined,
  beforeTs: string
): Promise<string | null> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    })

    if (!result.messages || result.messages.length <= 1) {
      return null
    }

    const formatted = result.messages
      .filter((m) => {
        if (Number(m.ts) >= Number(beforeTs)) return false
        return true
      })
      .map((m) => {
        const isBot = m.user === botUserId || "bot_id" in m
        const label = isBot ? "Jane" : m.user
        const text = m.text?.replace(/<@[A-Z0-9]+>/g, "").trim() || ""
        return `[${label}]: ${text}`
      })
      .filter((line) => {
        const afterColon = line.split(": ").slice(1).join(": ")
        return afterColon.length > 0
      })
      .join("\n")

    return formatted || null
  } catch (error) {
    log.error("Failed to fetch thread history", error)
    return null
  }
}

/**
 * Build context-aware system prompt with user info for privacy.
 */
function buildSystemPrompt(userId: string): string {
  const privacyContext = `
## Current Context
- Slack User ID: ${userId}

## Thread Privacy Rules
When using find_thread or read_thread:
- For "my threads" or "my previous conversations": filter with "label:slack-user-${userId}"
- Public and workspace-visible threads are fine to search and reference
- DM conversations with other users are private — don't access threads labeled with other user IDs
`
  return soulPrompt ? `${soulPrompt}\n${privacyContext}` : privacyContext
}

/**
 * Upload generated files from a Sprite to a Slack channel.
 * Downloads files from the Sprite and uploads them to Slack.
 */
async function uploadGeneratedFiles(
  client: typeof app.client,
  spriteName: string,
  files: GeneratedFile[],
  channelId: string,
  threadTs: string
): Promise<string[]> {
  const errors: string[] = []
  if (files.length === 0) return errors

  const token = config.spritesToken
  const spritesClient = token ? new SpritesClient(token) : null

  for (const file of files) {
    try {
      let fileData: Buffer

      // Prefer embedded data (from amp output) over downloading from Sprite
      if (file.data) {
        log.info("Using embedded image data", { filename: file.filename, size: file.data.length })
        fileData = file.data
      } else if (spritesClient) {
        // Fall back to downloading from Sprite
        log.info("Downloading file from sprite", { sprite: spriteName, path: file.path })
        fileData = await spritesClient.downloadFile(spriteName, file.path)
      } else {
        log.warn("No image data and no Sprites client, skipping file", { path: file.path })
        errors.push(`Could not upload ${file.filename}: no image data available`)
        continue
      }

      log.info("Uploading file to Slack", { filename: file.filename, size: fileData.length })

      await client.filesUploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file: fileData,
        filename: file.filename,
      })

      log.info("File uploaded to Slack", { filename: file.filename })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.error(`Failed to upload file ${file.path}`, err)
      errors.push(`Failed to upload ${file.filename}: ${errMsg}`)
    }
  }
  
  return errors
}

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
  // Excluded: find_thread, read_thread, handoff, task_list
]

async function runAmpInSprite(
  prompt: string,
  userId: string
): Promise<{ content: string; threadId: string | undefined; generatedFiles: GeneratedFile[]; spriteName: string }> {
  const result = await executeInSprite({
    userId,
    prompt,
    systemPrompt: buildSystemPrompt(userId),
  })
  return {
    content: result.content,
    threadId: result.threadId,
    generatedFiles: result.generatedFiles,
    spriteName: result.spriteName,
  }
}

async function runAmpLocal(
  prompt: string,
  userId: string
): Promise<{ content: string; threadId: string | undefined }> {
  const messages = execute({
    prompt,
    options: {
      cwd: config.workspaceDir,
      mode: config.agentMode,
      mcpConfig:
        Object.keys(config.mcpServers).length > 0 ? config.mcpServers : undefined,
      systemPrompt: buildSystemPrompt(userId),
      labels: [`slack-user-${userId}`],
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

interface AmpExecutionResult {
  content: string
  threadId: string | undefined
  generatedFiles?: GeneratedFile[]
  spriteName?: string
}

const TRANSIENT_ERROR_PATTERNS = [
  "Model Provider Overloaded",
  "overloaded",
  "rate limit",
  "529",
  "503",
]

function isTransientError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()))
}

const AMP_RETRY_COUNT = 2
const AMP_RETRY_DELAY_MS = 5000

async function runAmp(
  prompt: string,
  userId: string
): Promise<AmpExecutionResult> {
  const execute = () => {
    if (config.spritesToken) {
      return runAmpInSprite(prompt, userId)
    }
    if (config.allowLocalExecution) {
      return runAmpLocal(prompt, userId)
    }
    throw new Error(
      "No execution environment configured. Set SPRITES_TOKEN for sandboxed execution, " +
        "or ALLOW_LOCAL_EXECUTION=true for unsandboxed local execution."
    )
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= AMP_RETRY_COUNT; attempt++) {
    try {
      return await execute()
    } catch (err) {
      lastError = err
      if (attempt < AMP_RETRY_COUNT && isTransientError(err)) {
        const delayMs = AMP_RETRY_DELAY_MS * (attempt + 1)
        log.warn("Transient error, retrying amp execution", {
          attempt: attempt + 1,
          maxRetries: AMP_RETRY_COUNT,
          delayMs,
          error: err instanceof Error ? err.message : String(err),
        })
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      throw err
    }
  }
  throw lastError
}

// Handle @mentions
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user
  const channelId = event.channel
  const slackThreadTs = event.thread_ts ?? event.ts

  if (!userId) return

  // Authorization check
  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized user", { userId })
    return
  }
  if (!isChannelAllowed(channelId)) {
    log.warn("Unauthorized channel", { channelId })
    return
  }

  // Strip the bot mention from the message
  const rawText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim()
  if (!rawText) {
    await say({
      text: "How can I help you?",
      thread_ts: slackThreadTs,
    })
    return
  }

  // Debounce key: channel + thread + user
  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  // Check if already processing this thread
  if (inFlight.has(sessionKey)) {
    // Queue message for next turn via debouncer
    debounce(debounceKey, rawText)
    return
  }

  // Show typing indicator
  await client.reactions
    .add({
      channel: channelId,
      timestamp: event.ts,
      name: "eyes",
    })
    .catch(() => {})

  const startTime = Date.now()

  try {
    inFlight.add(sessionKey)

    let prompt = await debounce(debounceKey, rawText)

    const isInThread = event.thread_ts !== undefined
    if (isInThread) {
      const botUserId = await getBotUserId(client)
      const history = await fetchThreadContext(client, channelId, slackThreadTs, botUserId, event.ts)
      if (history) {
        prompt = `Previous messages in this Slack thread:\n${history}\n\nLatest message: ${prompt}`
      }
    }

    log.request("mention", userId, channelId, prompt)

    const result = await runAmp(prompt, userId)

    let uploadErrors: string[] = []
    if (result.generatedFiles?.length && result.spriteName) {
      uploadErrors = await uploadGeneratedFiles(client, result.spriteName, result.generatedFiles, channelId, slackThreadTs)
    }

    let content = result.content || "Done."
    if (uploadErrors.length > 0) {
      content += `\n\n_Note: ${uploadErrors.join("; ")}_`
    }
    const formatted = cleanSlackMessage(markdownToSlack(content))
    await sendChunkedResponse(say, formatted, slackThreadTs)

    log.response("mention", userId, Date.now() - startTime, true)

    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    log.error("Error processing mention", error)
    log.response("mention", userId, Date.now() - startTime, false)
    cancel(debounceKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    await client.reactions
      .add({ channel: channelId, timestamp: event.ts, name: "x" })
      .catch(() => {})
  } finally {
    inFlight.delete(sessionKey)

    await client.reactions
      .remove({
        channel: channelId,
        timestamp: event.ts,
        name: "eyes",
      })
      .catch(() => {})
  }
})

// Handle direct messages
app.event("message", async ({ event, client, say }) => {
  // Only handle DMs (channel type "im")
  if (event.channel_type !== "im") return

  // Ignore bot messages and message_changed events
  if ("bot_id" in event || "subtype" in event) return

  const messageEvent = event as {
    ts: string
    thread_ts?: string
    text?: string
    channel: string
    user?: string
  }

  const userId = messageEvent.user
  if (!userId) return

  // Authorization check
  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized DM user", { userId })
    return
  }

  const slackThreadTs = messageEvent.thread_ts ?? messageEvent.ts
  const channelId = messageEvent.channel
  const rawText = messageEvent.text ?? ""

  if (!rawText) return

  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  // Check if already processing
  if (inFlight.has(sessionKey)) {
    debounce(debounceKey, rawText)
    return
  }

  // Show typing indicator
  await client.reactions
    .add({
      channel: channelId,
      timestamp: messageEvent.ts,
      name: "eyes",
    })
    .catch(() => {})

  const startTime = Date.now()

  try {
    inFlight.add(sessionKey)

    let prompt = await debounce(debounceKey, rawText)

    const isInThread = messageEvent.thread_ts !== undefined
    if (isInThread) {
      const botUserId = await getBotUserId(client)
      const history = await fetchThreadContext(client, channelId, slackThreadTs, botUserId, messageEvent.ts)
      if (history) {
        prompt = `Previous messages in this Slack thread:\n${history}\n\nLatest message: ${prompt}`
      }
    }

    log.request("dm", userId, channelId, prompt)

    const result = await runAmp(prompt, userId)

    // Upload any generated files (images from painter tool, etc.)
    let uploadErrors: string[] = []
    if (result.generatedFiles?.length && result.spriteName) {
      uploadErrors = await uploadGeneratedFiles(client, result.spriteName, result.generatedFiles, channelId, slackThreadTs)
    }

    let content = result.content || "Done."
    if (uploadErrors.length > 0) {
      content += `\n\n_Note: ${uploadErrors.join("; ")}_`
    }
    const formatted = cleanSlackMessage(markdownToSlack(content))
    await sendChunkedResponse(say, formatted, slackThreadTs)

    log.response("dm", userId, Date.now() - startTime, true)

    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    log.error("Error processing DM", error)
    log.response("dm", userId, Date.now() - startTime, false)
    cancel(debounceKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    await client.reactions
      .add({ channel: channelId, timestamp: messageEvent.ts, name: "x" })
      .catch(() => {})
  } finally {
    inFlight.delete(sessionKey)

    await client.reactions
      .remove({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: "eyes",
      })
      .catch(() => {})
  }
})

async function sendChunkedResponse(
  say: (args: { text: string; thread_ts: string }) => Promise<unknown>,
  content: string,
  threadTs: string
) {
  const chunks = splitIntoChunks(content)
  for (const chunk of chunks) {
    await say({ text: chunk, thread_ts: threadTs })
  }
}

// Start the app
async function main() {
  if (!config.spritesToken && !config.allowLocalExecution) {
    throw new Error(
      "No execution environment configured. Set SPRITES_TOKEN for sandboxed execution, " +
        "or ALLOW_LOCAL_EXECUTION=true for unsandboxed local execution."
    )
  }

  await app.start()

  // Initialize sprite runners in background (non-blocking)
  if (config.spritesToken) {
    const spritesClient = new SpritesClient(config.spritesToken)
    initRunners(spritesClient, 2)
  }

  const executionMode = config.spritesToken ? "sprites" : "local (UNSANDBOXED)"
  log.startup({
    workspace: config.workspaceDir,
    mode: config.agentMode,
    debounce: config.debounceMs,
    hasSoul: !!soulPrompt,
    execution: executionMode,
  })
}

main().catch((err) => log.error("Startup failed", err))
