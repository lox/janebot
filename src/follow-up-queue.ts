export interface QueuedFollowUp {
  type: "mention" | "dm"
  userId: string
  eventTs: string
  rawText: string
  isInThread: boolean
}

export interface FollowUpBatchSummary {
  type: "mention" | "dm"
  userId: string
  latestEventTs: string
  eventTimestamps: string[]
  message: string
  isInThread: boolean
  includeThreadHistory: boolean
  excludedHistoryEventTs: string[]
}

const queuedByThread = new Map<string, QueuedFollowUp[]>()

const STEERING_PATTERNS = [
  /^actually[\s,].*(?:instead|don't|do not|stop|cancel|ignore|scratch|wait|no)\b/i,
  /^instead[\s,]/i,
  /\bignore that\b/i,
  /\bscratch that\b/i,
  /\bdon't do that\b/i,
  /\bdo not do that\b/i,
  /^(?:stop|cancel|abort|\/abort)$/i,
]

export function isSteeringMessage(rawText: string): boolean {
  const text = rawText.trim()
  if (text.length === 0) return false
  return STEERING_PATTERNS.some((pattern) => pattern.test(text))
}

export function enqueueFollowUp(threadKey: string, message: QueuedFollowUp): void {
  const queue = queuedByThread.get(threadKey) ?? []

  if (isSteeringMessage(message.rawText)) {
    queue.length = 0
  }

  queue.push(message)
  queuedByThread.set(threadKey, queue)
}

export function drainFollowUpBatch(threadKey: string): QueuedFollowUp[] {
  const queue = queuedByThread.get(threadKey)
  if (!queue || queue.length === 0) {
    return []
  }

  queuedByThread.delete(threadKey)
  return [...queue]
}

export function getFollowUpCount(threadKey: string): number {
  return queuedByThread.get(threadKey)?.length ?? 0
}

export function clearFollowUpQueue(threadKey: string): void {
  queuedByThread.delete(threadKey)
}

export function formatFollowUpPrompt(batch: QueuedFollowUp[]): string {
  if (batch.length === 0) return ""
  if (batch.length === 1) {
    return batch[0]?.rawText ?? ""
  }

  return batch
    .map((message) => `[${message.userId}]: ${message.rawText}`)
    .join("\n\n")
}

export function summarizeFollowUpBatch(batch: QueuedFollowUp[]): FollowUpBatchSummary | undefined {
  if (batch.length === 0) return undefined

  const latest = batch[batch.length - 1]
  if (!latest) return undefined

  const eventTimestamps = Array.from(new Set(batch.map((message) => message.eventTs)))
  const isInThread = batch.some((message) => message.isInThread)

  return {
    type: latest.type,
    userId: latest.userId,
    latestEventTs: latest.eventTs,
    eventTimestamps,
    message: formatFollowUpPrompt(batch),
    isInThread,
    includeThreadHistory: isInThread,
    excludedHistoryEventTs: eventTimestamps,
  }
}
