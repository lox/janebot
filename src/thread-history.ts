export interface ThreadHistoryMessage {
  ts?: string
  user?: string
  text?: string
  bot_id?: string
}

interface FormatThreadHistoryInput {
  messages: ThreadHistoryMessage[] | undefined
  botUserId: string | undefined
  beforeTs: string
  afterTs?: string
  excludedEventTs?: readonly string[]
}

export function formatThreadHistory(input: FormatThreadHistoryInput): string | null {
  const { messages, botUserId, beforeTs, afterTs, excludedEventTs = [] } = input

  if (!messages || messages.length === 0) {
    return null
  }

  const excludedEventSet = new Set(excludedEventTs)

  const formatted = messages
    .filter((message) => {
      if (!message.ts) return false
      if (Number(message.ts) >= Number(beforeTs)) return false
      if (afterTs && Number(message.ts) <= Number(afterTs)) return false
      if (excludedEventSet.has(message.ts)) return false
      return true
    })
    .map((message) => {
      const isBot = message.user === botUserId || "bot_id" in message
      const label = isBot ? "Jane" : message.user
      const text = message.text?.replace(/<@[A-Z0-9]+>/g, "").trim() || ""
      return `[${label}]: ${text}`
    })
    .filter((line) => {
      const afterColon = line.split(": ").slice(1).join(": ")
      return afterColon.length > 0
    })
    .join("\n")

  return formatted || null
}
