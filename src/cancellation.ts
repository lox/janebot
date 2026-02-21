export function isExpectedCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const withCode = error as Error & { code?: string; cause?: unknown }
  if (withCode.code === "JANE_USER_ABORT" || withCode.code === "JANE_USER_CANCEL") {
    return true
  }

  const cause = withCode.cause as { code?: unknown } | undefined
  if (cause?.code === "JANE_USER_ABORT" || cause?.code === "JANE_USER_CANCEL") {
    return true
  }

  const message = error.message.toLowerCase()
  return message.includes("[user-abort]") || message.includes("user requested abort")
}
