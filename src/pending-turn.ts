export interface PendingTurn {
  type: "mention" | "dm"
  userId: string
  eventTs: string
  eventTimestamps: string[]
  message: string
  isInThread: boolean
  includeThreadHistory: boolean
  excludedHistoryEventTs: string[]
}

interface BuildInitialPendingTurnInput {
  type: "mention" | "dm"
  userId: string
  fallbackEventTs: string
  eventTimestamps: string[]
  message: string
  isInThread: boolean
}

export function buildInitialPendingTurn(input: BuildInitialPendingTurnInput): PendingTurn {
  const dedupedEventTimestamps = Array.from(new Set(input.eventTimestamps))
  const eventTs = dedupedEventTimestamps[dedupedEventTimestamps.length - 1] ?? input.fallbackEventTs

  return {
    type: input.type,
    userId: input.userId,
    eventTs,
    eventTimestamps: dedupedEventTimestamps,
    message: input.message,
    isInThread: input.isInThread,
    includeThreadHistory: input.isInThread,
    excludedHistoryEventTs: dedupedEventTimestamps,
  }
}
