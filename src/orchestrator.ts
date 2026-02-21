import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent"

import { config } from "./config.js"
import { runCodingSubagent, type RunCodingSubagentResult } from "./coding-subagent.js"
import type { GeneratedFile } from "./sprite-executor.js"
import * as log from "./logger.js"

interface OrchestratorSession {
  key: string
  session: AgentSession
  generatedFiles: GeneratedFile[]
  progressCallback?: (message: string) => Promise<void>
  subagentSystemPrompt: string
  lastSeenEventTs?: string
}

export interface OrchestratorInput {
  channelId: string
  threadTs: string
  userId: string
  eventTs: string
  message: string
  systemPrompt: string
  subagentSystemPrompt: string
  progressCallback?: (message: string) => Promise<void>
}

export interface OrchestratorResult {
  content: string
  generatedFiles: GeneratedFile[]
  sessionCreated: boolean
}

const sessions = new Map<string, OrchestratorSession>()

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`
}

export function hasOrchestratorSession(channelId: string, threadTs: string): boolean {
  return sessions.has(makeKey(channelId, threadTs))
}

export function getLastSeenEventTs(channelId: string, threadTs: string): string | undefined {
  return sessions.get(makeKey(channelId, threadTs))?.lastSeenEventTs
}

function formatSubagentResult(result: RunCodingSubagentResult): string {
  const parts: string[] = []
  parts.push(`status=${result.status}`)
  if (result.subagentSessionId) parts.push(`subagent_session_id=${result.subagentSessionId}`)
  if (result.jobId) parts.push(`job_id=${result.jobId}`)
  if (result.sandboxName) parts.push(`sandbox=${result.sandboxName}`)
  if (typeof result.created === "boolean") parts.push(`created=${result.created}`)
  if (result.content) parts.push(`content=${result.content}`)
  if (result.generatedFiles.length > 0) {
    parts.push(`artifacts=${result.generatedFiles.map((f) => f.filename).join(",")}`)
  }
  return parts.join("\n")
}

function toSafeDetails(result: RunCodingSubagentResult): Record<string, unknown> {
  return {
    status: result.status,
    subagentSessionId: result.subagentSessionId,
    jobId: result.jobId,
    created: result.created,
    sandboxName: result.sandboxName,
    content: result.content,
    generatedFiles: result.generatedFiles.map((file) => ({
      path: file.path,
      filename: file.filename,
    })),
  }
}

type MessageLike = { role?: string; content?: unknown }

function extractAssistantText(messages: MessageLike[], beforeCount: number): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i < beforeCount) break

    const message = messages[i] as unknown as { role?: string; content?: unknown }
    if (message.role !== "assistant") continue

    const content = message.content
    if (typeof content === "string" && content.trim().length > 0) {
      return content
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const candidate = part as { type?: string; text?: string }
          if (candidate.type === "text" && typeof candidate.text === "string") {
            return candidate.text
          }
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text.trim().length > 0) {
        return text
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as unknown as { role?: string; content?: unknown }
    if (message.role !== "assistant") continue
    if (typeof message.content === "string" && message.content.trim()) return message.content
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const candidate = part as { type?: string; text?: string }
          if (candidate.type === "text" && typeof candidate.text === "string") {
            return candidate.text
          }
          return ""
        })
        .filter(Boolean)
        .join("\n")
      if (text.trim()) return text
    }
  }

  return ""
}

function buildOrchestratorTool(
  channelId: string,
  threadTs: string,
  generatedFiles: GeneratedFile[],
  getSubagentSystemPrompt: () => string,
  getProgressCallback: () => ((message: string) => Promise<void>) | undefined,
): ToolDefinition {
  return {
    name: "run_coding_subagent",
    label: "Run Coding Subagent",
    description:
      "Delegate coding work to the thread's persistent sandbox subagent. " +
      "Use action=send with an instruction for coding tasks. Use status/abort for control.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send", "status", "abort"],
          description: "Subagent action",
        },
        instruction: {
          type: "string",
          description: "Instruction text for action=send",
        },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const parsedParams = params as { action: "send" | "status" | "abort"; instruction?: string }

      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: {},
        }
      }

      if (parsedParams.action === "status") {
        const result = await runCodingSubagent({ action: "status", channelId, threadTs })
        return {
          content: [{ type: "text", text: formatSubagentResult(result) }],
          details: toSafeDetails(result),
        }
      }

      if (parsedParams.action === "abort") {
        const result = await runCodingSubagent({ action: "abort", channelId, threadTs })
        return {
          content: [{ type: "text", text: formatSubagentResult(result) }],
          details: toSafeDetails(result),
        }
      }

      const instruction = parsedParams.instruction?.trim()
      if (!instruction) {
        return {
          content: [{ type: "text", text: "Missing instruction for action=send" }],
          details: {},
        }
      }

      const currentStatus = await runCodingSubagent({ action: "status", channelId, threadTs })
      if (currentStatus.status === "not_found") {
        const progressCallback = getProgressCallback()
        if (progressCallback) {
          await progressCallback(
            "_Spinning up a coding environment for this thread. First run can take a minute._"
          ).catch(() => {})
        }
      }

      const result = await runCodingSubagent({
        action: "message",
        channelId,
        threadTs,
        message: instruction,
        systemPrompt: getSubagentSystemPrompt(),
      })

      generatedFiles.push(...result.generatedFiles)

      return {
        content: [{ type: "text", text: formatSubagentResult(result) }],
        details: toSafeDetails(result),
      }
    },
  }
}

async function createOrchestratorSession(
  channelId: string,
  threadTs: string,
  systemPrompt: string,
  subagentSystemPrompt: string,
): Promise<OrchestratorSession> {
  const key = makeKey(channelId, threadTs)
  const generatedFiles: GeneratedFile[] = []

  const loader = new DefaultResourceLoader({
    cwd: config.workspaceDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: () => ({
      agentsFiles: [
        {
          path: "/virtual/AGENTS.md",
          content: systemPrompt,
        },
      ],
    }),
  })
  await loader.reload()

  const customTools: ToolDefinition[] = [
    buildOrchestratorTool(
      channelId,
      threadTs,
      generatedFiles,
      () => sessions.get(key)?.subagentSystemPrompt ?? subagentSystemPrompt,
      () => sessions.get(key)?.progressCallback
    ),
  ]

  const { session } = await createAgentSession({
    cwd: config.workspaceDir,
    resourceLoader: loader,
    tools: [],
    customTools,
    sessionManager: SessionManager.inMemory(),
  })

  const orchestratorSession: OrchestratorSession = {
    key,
    session,
    generatedFiles,
    subagentSystemPrompt,
  }

  sessions.set(key, orchestratorSession)
  return orchestratorSession
}

async function getOrCreateSession(
  channelId: string,
  threadTs: string,
  systemPrompt: string,
  subagentSystemPrompt: string,
): Promise<{ session: OrchestratorSession; created: boolean }> {
  const key = makeKey(channelId, threadTs)
  const existing = sessions.get(key)
  if (existing) {
    return { session: existing, created: false }
  }

  const created = await createOrchestratorSession(
    channelId,
    threadTs,
    systemPrompt,
    subagentSystemPrompt,
  )
  return { session: created, created: true }
}

export async function runOrchestratorTurn(input: OrchestratorInput): Promise<OrchestratorResult> {
  log.debug("Running orchestrator turn", {
    channelId: input.channelId,
    threadTs: input.threadTs,
    userId: input.userId,
  })
  const { session, created } = await getOrCreateSession(
    input.channelId,
    input.threadTs,
    input.systemPrompt,
    input.subagentSystemPrompt,
  )

  session.progressCallback = input.progressCallback
  session.subagentSystemPrompt = input.subagentSystemPrompt
  session.generatedFiles.length = 0

  const beforeCount = session.session.messages.length
  await session.session.prompt(input.message)

  session.lastSeenEventTs = input.eventTs
  log.debug("Orchestrator prompt complete", {
    channelId: input.channelId,
    threadTs: input.threadTs,
    sessionCreated: created,
  })

  const content = extractAssistantText(session.session.messages, beforeCount) || "Done."

  return {
    content,
    generatedFiles: [...session.generatedFiles],
    sessionCreated: created,
  }
}
