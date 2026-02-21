import * as log from "./logger.js"

const DEBUG_PI_OUTPUT = process.env.DEBUG_PI_OUTPUT === "1"

interface PiEvent {
  type: string
  [key: string]: unknown
}

interface PiAgentEndEvent extends PiEvent {
  type: "agent_end"
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string }>
    model?: string
  }>
}

interface PiMessageStartEvent extends PiEvent {
  type: "message_start"
  message: {
    role: string
    model?: string
    content: Array<{ type: string; text?: string }>
  }
}

export interface GeneratedFile {
  path: string
  filename: string
  data?: Buffer
}

export function parsePiOutput(stdout: string): {
  content: string
  model: string | undefined
} {
  if (DEBUG_PI_OUTPUT) {
    log.info("Raw pi stdout", { length: stdout.length, preview: stdout.slice(0, 2000) })
  }

  const events: PiEvent[] = []
  const lines = stdout.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as PiEvent)
    } catch {
      // Non-JSON line — ignore
    }
  }

  const agentEnd = events.find((e): e is PiAgentEndEvent => e.type === "agent_end")
  if (!agentEnd) {
    throw new Error("Pi execution failed: no agent_end event in output")
  }

  let content = ""
  for (let i = agentEnd.messages.length - 1; i >= 0; i--) {
    const msg = agentEnd.messages[i]
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
      if (textParts.length > 0) {
        content = textParts.join("\n")
        break
      }
    }
  }

  const firstAssistant = events.find(
    (e): e is PiMessageStartEvent =>
      e.type === "message_start" &&
      (e as PiMessageStartEvent).message?.role === "assistant"
  )
  const model = firstAssistant?.message?.model

  return { content, model }
}
