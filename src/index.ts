import "dotenv/config"
import { App, LogLevel } from "@slack/bolt"

import { config, isUserAllowed, isChannelAllowed } from "./config.js"
import { debounce, cancel } from "./debouncer.js"
import {
  clearFollowUpQueue,
  drainFollowUpBatch,
  enqueueFollowUp,
  getFollowUpCount,
  summarizeFollowUpBatch,
} from "./follow-up-queue.js"
import { markdownToSlack } from "md-to-slack"
import * as log from "./logger.js"
import { getLastSeenEventTs } from "./orchestrator.js"
import { buildInitialPendingTurn, type PendingTurn } from "./pending-turn.js"
import type { GeneratedFile } from "./pi-output.js"
import { initSandboxClient, getSandboxClient } from "./sandbox.js"
import { initSessionStore } from "./session-store.js"
import { SpritesClient } from "./sprites.js"
import { DockerSandboxClient } from "./docker-sandbox.js"
import { cleanSlackMessage, formatErrorForUser, splitIntoChunks } from "./helpers.js"
import { extractControlCommand, hasSoulPrompt, runControlCommand, runThreadTurn } from "./thread-runtime.js"

// Track in-flight requests to prevent duplicate processing
const inFlight = new Set<string>()
const debouncingKeyBySession = new Map<string, string>()
const debouncedEventTsByKey = new Map<string, string[]>()

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
  beforeTs: string,
  afterTs?: string,
  excludedEventTs: readonly string[] = []
): Promise<string | null> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
      latest: beforeTs,
      inclusive: false,
      ...(afterTs ? { oldest: afterTs } : {}),
    })

    if (!result.messages || result.messages.length <= 1) {
      return null
    }

    const excludedEventSet = new Set(excludedEventTs)

    const formatted = result.messages
      .filter((m) => {
        if (!m.ts) return false
        if (Number(m.ts) >= Number(beforeTs)) return false
        if (afterTs && Number(m.ts) <= Number(afterTs)) return false
        if (excludedEventSet.has(m.ts)) return false
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

function isExpectedCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError") return true

  const message = error.message.toLowerCase()
  return message.includes("cancelled") || message.includes("canceled") || message.includes("aborted")
}

async function executePendingTurn(params: {
  turn: PendingTurn
  channelId: string
  slackThreadTs: string
  client: typeof app.client
  say: (args: { text: string; thread_ts: string }) => Promise<unknown>
}): Promise<void> {
  const { turn, channelId, slackThreadTs, client, say } = params

  let prompt = turn.message
  if (turn.includeThreadHistory && turn.isInThread) {
    const botUserId = await getBotUserId(client)
    const afterTs = getLastSeenEventTs(channelId, slackThreadTs)
    const history = await fetchThreadContext(
      client,
      channelId,
      slackThreadTs,
      botUserId,
      turn.eventTs,
      afterTs,
      turn.excludedHistoryEventTs,
    )
    if (history) {
      const label = afterTs ? "New messages in thread since last turn" : "Previous messages in this Slack thread"
      prompt = `${label}:\n${history}\n\nLatest message: ${prompt}`
    }
  }

  log.request(turn.type, turn.userId, channelId, prompt)
  const startedAt = Date.now()

  const result = await runThreadTurn({
    channelId,
    threadTs: slackThreadTs,
    userId: turn.userId,
    eventTs: turn.eventTs,
    message: prompt,
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

  log.response(turn.type, turn.userId, Date.now() - startedAt, true)

  for (const timestamp of turn.eventTimestamps) {
    await client.reactions
      .add({
        channel: channelId,
        timestamp,
        name: "white_check_mark",
      })
      .catch(() => {})
  }
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
    const commandResult = await runControlCommand(command, channelId, slackThreadTs)
    await say({
      text: commandResult,
      thread_ts: slackThreadTs,
    })
    return
  }

  const debounceKey = `${channelId}:${slackThreadTs}:${userId}`
  const sessionKey = `${channelId}:${slackThreadTs}`

  if (inFlight.has(sessionKey)) {
    const activeDebounceKey = debouncingKeyBySession.get(sessionKey)
    if (activeDebounceKey === debounceKey) {
      // While the first turn is still waiting on debounce, same-user messages should keep batching.
      const pendingEventTs = debouncedEventTsByKey.get(debounceKey) ?? []
      pendingEventTs.push(eventTs)
      debouncedEventTsByKey.set(debounceKey, pendingEventTs)
      void debounce(debounceKey, rawText)
      return
    }

    enqueueFollowUp(sessionKey, {
      type,
      userId,
      eventTs,
      rawText,
      isInThread,
    })
    log.debug("Queued follow-up while turn is running", {
      sessionKey,
      queuedCount: getFollowUpCount(sessionKey),
    })
    return
  }

  await client.reactions
    .add({
      channel: channelId,
      timestamp: eventTs,
      name: "eyes",
    })
    .catch(() => {})

  const runStartedAt = Date.now()
  let activeTurn: PendingTurn | undefined
  let activeTurnStartedAt = runStartedAt

  try {
    inFlight.add(sessionKey)

    debouncingKeyBySession.set(sessionKey, debounceKey)
    debouncedEventTsByKey.set(debounceKey, [eventTs])
    const initialMessage = await debounce(debounceKey, rawText)
    const initialEventTimestamps = debouncedEventTsByKey.get(debounceKey) ?? [eventTs]
    debouncingKeyBySession.delete(sessionKey)
    debouncedEventTsByKey.delete(debounceKey)

    activeTurn = buildInitialPendingTurn({
      type,
      userId,
      eventTimestamps: initialEventTimestamps,
      fallbackEventTs: eventTs,
      message: initialMessage,
      isInThread,
    })

    while (activeTurn) {
      activeTurnStartedAt = Date.now()
      await executePendingTurn({
        turn: activeTurn,
        channelId,
        slackThreadTs,
        client,
        say,
      })

      const queuedBatch = drainFollowUpBatch(sessionKey)
      if (queuedBatch.length === 0) {
        activeTurn = undefined
        break
      }

      log.debug("Draining queued follow-up messages", {
        sessionKey,
        queuedCount: queuedBatch.length,
      })

      const latestQueued = queuedBatch[queuedBatch.length - 1]
      if (!latestQueued) {
        activeTurn = undefined
        break
      }

      // If summarisation fails, keep error attribution on the latest queued message instead of the initial turn.
      activeTurn = {
        type: latestQueued.type,
        userId: latestQueued.userId,
        eventTs: latestQueued.eventTs,
        eventTimestamps: [latestQueued.eventTs],
        message: latestQueued.rawText,
        isInThread: latestQueued.isInThread,
        includeThreadHistory: latestQueued.isInThread,
        excludedHistoryEventTs: [latestQueued.eventTs],
      }

      const nextSummary = summarizeFollowUpBatch(queuedBatch)
      if (!nextSummary) {
        activeTurn = undefined
        break
      }

      activeTurn = {
        type: nextSummary.type,
        userId: nextSummary.userId,
        eventTs: nextSummary.latestEventTs,
        eventTimestamps: nextSummary.eventTimestamps,
        message: nextSummary.message,
        isInThread: nextSummary.isInThread,
        includeThreadHistory: nextSummary.includeThreadHistory,
        excludedHistoryEventTs: nextSummary.excludedHistoryEventTs,
      }
    }
  } catch (error) {
    if (isExpectedCancellationError(error)) {
      log.warn("Message processing interrupted", {
        sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      })
      cancel(debounceKey)
      clearFollowUpQueue(sessionKey)
      return
    }

    log.error("Error processing message", error)
    if (activeTurn) {
      log.response(activeTurn.type, activeTurn.userId, Date.now() - activeTurnStartedAt, false)
    } else {
      log.response(type, userId, Date.now() - runStartedAt, false)
    }
    cancel(debounceKey)
    clearFollowUpQueue(sessionKey)

    await say({
      text: formatErrorForUser(error),
      thread_ts: slackThreadTs,
    })

    const errorTimestamps = activeTurn?.eventTimestamps ?? [eventTs]
    for (const timestamp of errorTimestamps) {
      await client.reactions
        .add({ channel: channelId, timestamp, name: "x" })
        .catch(() => {})
    }
  } finally {
    inFlight.delete(sessionKey)
    debouncingKeyBySession.delete(sessionKey)
    debouncedEventTsByKey.delete(debounceKey)

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

async function runStartupDiagnostics(): Promise<void> {
  const client = getSandboxClient()
  log.info("Running startup sandbox diagnostics", { backend: config.sandboxBackend })
  const startedAt = Date.now()

  try {
    const sandboxes = await client.list("jane-")
    const counts = {
      total: sandboxes.length,
      running: 0,
      warm: 0,
      cold: 0,
    }

    for (const sandbox of sandboxes) {
      if (sandbox.status === "running") counts.running += 1
      if (sandbox.status === "warm") counts.warm += 1
      if (sandbox.status === "cold") counts.cold += 1
    }

    log.info("Sandbox backend verified", {
      backend: config.sandboxBackend,
      durationMs: Date.now() - startedAt,
      sandboxes: counts,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn("Sandbox startup diagnostics failed", {
      backend: config.sandboxBackend,
      error: message,
    })
  }
}

function createSandboxClient() {
  if (config.sandboxBackend === "docker") {
    return new DockerSandboxClient()
  }
  if (!config.spritesToken) {
    throw new Error("Sandbox token (SPRITES_TOKEN) is required when using the sprites backend")
  }
  return new SpritesClient(config.spritesToken)
}

// Start the app
async function main() {
  initSessionStore(config.sessionDbPath)

  const client = createSandboxClient()
  initSandboxClient(client)

  await app.start()

  log.startup({
    workspace: config.workspaceDir,
    piModel: config.piModel || "default",
    debounce: config.debounceMs,
    hasSoul: hasSoulPrompt(),
    execution: `orchestrator + ${config.sandboxBackend} workers`,
    sessionDbPath: config.sessionDbPath,
    githubApp: !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID),
  })

  // Run diagnostics in background so Slack connectivity is never blocked.
  void runStartupDiagnostics()
}

main().catch((err) => log.error("Startup failed", err))
