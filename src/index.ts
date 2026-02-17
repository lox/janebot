import "dotenv/config"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { App, LogLevel } from "@slack/bolt"

import { config, isUserAllowed, isChannelAllowed } from "./config.js"
import { debounce, cancel } from "./debouncer.js"
import { markdownToSlack } from "md-to-slack"
import * as log from "./logger.js"
import { runCodingSubagent } from "./coding-subagent.js"
import { hasOrchestratorSession, runOrchestratorTurn } from "./orchestrator.js"
import type { GeneratedFile } from "./sprite-executor.js"
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
 * Build system prompt for sprite coding subagents.
 */
function buildSubagentSystemPrompt(userId: string): string {
  const privacyContext = `
## Current Context
- Slack User ID: ${userId}

## Privacy
- You cannot access other conversations. You only see the provided Slack thread history.
- Never share credentials, tokens, or secrets.

## File Output
- If you generate files for the user, write them to /home/sprite/artifacts/.
`
  return soulPrompt ? `${soulPrompt}\n${privacyContext}` : privacyContext
}

/**
 * Build system prompt for top-level host orchestrator.
 */
function buildOrchestratorSystemPrompt(userId: string): string {
  const orchestratorContext = `
## Role
- You are Jane, a high-velocity orchestration agent.
- You do not edit files or run shell commands directly on the host.
- Delegate coding work through the run_coding_subagent tool.

## Delegation Rules
- For coding tasks, call run_coding_subagent with action="send".
- Include clear, complete instructions in each tool call.
- You may call the tool multiple times in one response to iterate.
- Use action="status" when you need current state.
- Use action="abort" only if the user explicitly asks to stop work.

## Communication
- After tool calls, summarize outcomes clearly for the user.
- If files were produced, mention them by name.

## Privacy
- Slack User ID: ${userId}
- Never reveal secrets or credentials.
`

  return soulPrompt ? `${soulPrompt}\n${orchestratorContext}` : orchestratorContext
}

/**
 * Upload generated files to a Slack channel.
 */
async function uploadGeneratedFiles(
  client: typeof app.client,
  files: GeneratedFile[],
  channelId: string,
  threadTs: string
): Promise<string[]> {
  const errors: string[] = []
  if (files.length === 0) return errors

  for (const file of files) {
    try {
      let fileData: Buffer

      if (file.data) {
        fileData = file.data
      } else {
        errors.push(`No data for ${file.filename}`)
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

function extractControlCommand(rawText: string): "status" | "abort" | null {
  const value = rawText.trim().toLowerCase()
  if (value === "/status" || value === "status") return "status"
  if (value === "/abort" || value === "abort") return "abort"
  return null
}

async function handleControlCommand(
  command: "status" | "abort",
  channelId: string,
  threadTs: string,
  say: (args: { text: string; thread_ts: string }) => Promise<unknown>
): Promise<boolean> {
  if (command === "status") {
    const result = await runCodingSubagent({
      action: "status",
      channelId,
      threadTs,
    })

    if (result.status === "not_found") {
      await say({
        text: "No coding subagent session exists for this thread yet.",
        thread_ts: threadTs,
      })
      return true
    }

    const details = [
      `status: ${result.status}`,
      result.jobId ? `job: ${result.jobId}` : undefined,
      result.subagentSessionId ? `session: ${result.subagentSessionId}` : undefined,
    ].filter(Boolean).join(" | ")

    await say({ text: details, thread_ts: threadTs })
    return true
  }

  const result = await runCodingSubagent({
    action: "abort",
    channelId,
    threadTs,
  })

  if (result.status === "not_found") {
    await say({
      text: "No active coding subagent session exists for this thread.",
      thread_ts: threadTs,
    })
    return true
  }

  await say({
    text: "Requested subagent abort for this thread.",
    thread_ts: threadTs,
  })
  return true
}

interface ProcessMessageParams {
  type: "mention" | "dm"
  userId: string
  channelId: string
  slackThreadTs: string
  eventTs: string
  rawText: string
  isInThread: boolean
  client: typeof app.client
  say: (args: { text: string; thread_ts: string }) => Promise<unknown>
}

async function processMessage(params: ProcessMessageParams): Promise<void> {
  const {
    type,
    userId,
    channelId,
    slackThreadTs,
    eventTs,
    rawText,
    isInThread,
    client,
    say,
  } = params

  const command = extractControlCommand(rawText)
  if (command) {
    await handleControlCommand(command, channelId, slackThreadTs, say)
    return
  }

  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  if (inFlight.has(sessionKey)) {
    debounce(debounceKey, rawText)
    return
  }

  await client.reactions
    .add({
      channel: channelId,
      timestamp: eventTs,
      name: "eyes",
    })
    .catch(() => {})

  const startTime = Date.now()

  try {
    inFlight.add(sessionKey)

    let prompt = await debounce(debounceKey, rawText)

    const hadOrchestratorSession = hasOrchestratorSession(channelId, slackThreadTs)
    if (isInThread && !hadOrchestratorSession) {
      const botUserId = await getBotUserId(client)
      const history = await fetchThreadContext(client, channelId, slackThreadTs, botUserId, eventTs)
      if (history) {
        prompt = `Previous messages in this Slack thread:\n${history}\n\nLatest message: ${prompt}`
      }
    }

    log.request(type, userId, channelId, prompt)

    const result = await runOrchestratorTurn({
      channelId,
      threadTs: slackThreadTs,
      userId,
      message: prompt,
      systemPrompt: buildOrchestratorSystemPrompt(userId),
      subagentSystemPrompt: buildSubagentSystemPrompt(userId),
      progressCallback: async (message) => {
        log.debug("Posting orchestrator progress update", {
          channelId,
          threadTs: slackThreadTs,
          message,
        })
        await say({
          text: message,
          thread_ts: slackThreadTs,
        })
      },
    })

    let uploadErrors: string[] = []
    if (result.generatedFiles.length) {
      uploadErrors = await uploadGeneratedFiles(client, result.generatedFiles, channelId, slackThreadTs)
    }

    let content = result.content || "Done."
    if (uploadErrors.length > 0) {
      content += `\n\n_Note: ${uploadErrors.join("; ")}_`
    }

    const formatted = cleanSlackMessage(markdownToSlack(content))
    await sendChunkedResponse(say, formatted, slackThreadTs)

    log.response(type, userId, Date.now() - startTime, true)

    await client.reactions
      .add({
        channel: channelId,
        timestamp: eventTs,
        name: "white_check_mark",
      })
      .catch(() => {})
  } catch (error) {
    log.error("Error processing message", error)
    log.response(type, userId, Date.now() - startTime, false)
    cancel(debounceKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    await client.reactions
      .add({ channel: channelId, timestamp: eventTs, name: "x" })
      .catch(() => {})
  } finally {
    inFlight.delete(sessionKey)

    await client.reactions
      .remove({
        channel: channelId,
        timestamp: eventTs,
        name: "eyes",
      })
      .catch(() => {})
  }
}

// Handle @mentions
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user
  const channelId = event.channel
  const slackThreadTs = event.thread_ts ?? event.ts

  if (!userId) return

  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized user", { userId })
    return
  }
  if (!isChannelAllowed(channelId)) {
    log.warn("Unauthorized channel", { channelId })
    return
  }

  const rawText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim()
  if (!rawText) {
    await say({ text: "How can I help you?", thread_ts: slackThreadTs })
    return
  }

  await processMessage({
    type: "mention",
    userId,
    channelId,
    slackThreadTs,
    eventTs: event.ts,
    rawText,
    isInThread: event.thread_ts !== undefined,
    client,
    say,
  })
})

// Handle direct messages
app.event("message", async ({ event, client, say }) => {
  if (event.channel_type !== "im") return
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

  if (!isUserAllowed(userId)) {
    log.warn("Unauthorized DM user", { userId })
    return
  }

  const slackThreadTs = messageEvent.thread_ts ?? messageEvent.ts
  const channelId = messageEvent.channel
  const rawText = messageEvent.text ?? ""
  if (!rawText) return

  await processMessage({
    type: "dm",
    userId,
    channelId,
    slackThreadTs,
    eventTs: messageEvent.ts,
    rawText,
    isInThread: messageEvent.thread_ts !== undefined,
    client,
    say,
  })
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
  if (!config.spritesToken) {
    throw new Error("SPRITES_TOKEN is required for orchestrator + subagent execution")
  }

  await app.start()

  log.startup({
    workspace: config.workspaceDir,
    piModel: config.piModel || "default",
    debounce: config.debounceMs,
    hasSoul: !!soulPrompt,
    execution: "orchestrator + sprite workers",
  })
}

main().catch((err) => log.error("Startup failed", err))
