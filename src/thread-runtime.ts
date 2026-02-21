import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { runCodingSubagent } from "./coding-subagent.js"
import { runOrchestratorTurn } from "./orchestrator.js"
import type { GeneratedFile } from "./sprite-executor.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const soulPath = join(__dirname, "..", "SOUL.md")
let soulPrompt = ""
try {
  soulPrompt = readFileSync(soulPath, "utf-8")
} catch {
  // SOUL.md is optional
}

export type ThreadControlCommand = "status" | "abort"

export interface ThreadTurnInput {
  userId: string
  channelId: string
  threadTs: string
  eventTs: string
  message: string
  progressCallback?: (message: string) => Promise<void>
}

export interface ThreadTurnResult {
  content: string
  generatedFiles: GeneratedFile[]
}

export function hasSoulPrompt(): boolean {
  return soulPrompt.length > 0
}

export function buildSubagentSystemPrompt(userId: string): string {
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

export function buildOrchestratorSystemPrompt(userId: string): string {
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

export function extractControlCommand(rawText: string): ThreadControlCommand | null {
  const value = rawText.trim().toLowerCase()
  if (value === "/status" || value === "status") return "status"
  if (value === "/abort" || value === "abort") return "abort"
  return null
}

export async function runControlCommand(
  command: ThreadControlCommand,
  channelId: string,
  threadTs: string
): Promise<string> {
  if (command === "status") {
    const result = await runCodingSubagent({
      action: "status",
      channelId,
      threadTs,
    })

    if (result.status === "not_found") {
      return "No coding subagent session exists for this thread yet."
    }

    return [
      `status: ${result.status}`,
      result.jobId ? `job: ${result.jobId}` : undefined,
      result.subagentSessionId ? `session: ${result.subagentSessionId}` : undefined,
    ].filter(Boolean).join(" | ")
  }

  const result = await runCodingSubagent({
    action: "abort",
    channelId,
    threadTs,
  })

  if (result.status === "not_found") {
    return "No active coding subagent session exists for this thread."
  }

  return "Requested subagent abort for this thread."
}

export async function runThreadTurn(input: ThreadTurnInput): Promise<ThreadTurnResult> {
  const result = await runOrchestratorTurn({
    channelId: input.channelId,
    threadTs: input.threadTs,
    userId: input.userId,
    eventTs: input.eventTs,
    message: input.message,
    systemPrompt: buildOrchestratorSystemPrompt(input.userId),
    subagentSystemPrompt: buildSubagentSystemPrompt(input.userId),
    progressCallback: input.progressCallback,
  })

  return {
    content: result.content || "Done.",
    generatedFiles: result.generatedFiles,
  }
}
