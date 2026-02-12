export function cleanSlackMessage(text: string): string {
  return text.replace(/<(\/[^|>]+)\|([^>]+)>/g, (_match, _path, label) => {
    return `\`${label}\``
  })
}

export function formatErrorForUser(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (
    lower.includes("no api key") ||
    lower.includes("login flow") ||
    message.includes("ANTHROPIC_API_KEY")
  ) {
    return "I'm not configured properly. Please check the ANTHROPIC_API_KEY."
  }
  if (message.includes("invalid_auth") || message.includes("token")) {
    return "Authentication failed. Please check the bot configuration."
  }
  if (message.includes("rate limit") || message.includes("too many")) {
    return "I'm being rate limited. Please try again in a moment."
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "The request timed out. Try a simpler task or try again."
  }

  return "Something went wrong. Please try again."
}

export function splitIntoChunks(content: string, maxLength = 3900): string[] {
  if (content.length <= maxLength) {
    return [content]
  }

  const chunks: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    let splitIndex = remaining.lastIndexOf("\n\n", maxLength)
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf("\n", maxLength)
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength)
    }
    if (splitIndex === -1) {
      splitIndex = maxLength
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  return chunks
}
