import "dotenv/config"
import { join } from "node:path"

export interface JanebotConfig {
  // Pi settings
  workspaceDir: string
  piModel: string | undefined
  piThinkingLevel: string | undefined

  // Behavior
  debounceMs: number
  maxResponseLength: number
  subagentPrewarmCount: number
  sessionDbPath: string

  // Authorization (empty arrays = allow all)
  allowedUserIds: string[]
  allowedChannelIds: string[]

  // Sandbox backend: "sprites" (Fly VMs) or "docker" (local Docker)
  sandboxBackend: "sprites" | "docker"

  // Sprites (required when sandboxBackend is "sprites")
  spritesToken: string | undefined

  // Git identity for commits made in sandboxes
  gitAuthorName: string | undefined
  gitAuthorEmail: string | undefined

  // Local execution (requires explicit opt-in, no sandbox)
  allowLocalExecution: boolean
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseSandboxBackend(): "sprites" | "docker" {
  const value = (process.env.SANDBOX_BACKEND ?? "").toLowerCase()
  if (value === "docker") return "docker"
  return "sprites"
}

export const config: JanebotConfig = {
  workspaceDir: process.env.WORKSPACE_DIR ?? process.cwd(),
  piModel: process.env.PI_MODEL || undefined,
  piThinkingLevel: process.env.PI_THINKING_LEVEL || undefined,
  debounceMs: parseInt(process.env.DEBOUNCE_MS ?? "1500", 10),
  maxResponseLength: parseInt(process.env.MAX_RESPONSE_LENGTH ?? "10000", 10),
  subagentPrewarmCount: parseInt(process.env.SUBAGENT_PREWARM_COUNT ?? "1", 10),
  sessionDbPath: process.env.SESSION_DB_PATH || join(process.env.WORKSPACE_DIR ?? process.cwd(), ".janebot", "state.sqlite"),
  allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
  allowedChannelIds: parseList(process.env.ALLOWED_CHANNEL_IDS),
  sandboxBackend: parseSandboxBackend(),
  spritesToken: process.env.SPRITES_TOKEN,
  gitAuthorName: process.env.GIT_AUTHOR_NAME,
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL,
  allowLocalExecution: process.env.ALLOW_LOCAL_EXECUTION === "true",
}

/**
 * Check if a user is authorized to use the bot.
 */
export function isUserAllowed(userId: string): boolean {
  if (config.allowedUserIds.length === 0) return true
  return config.allowedUserIds.includes(userId)
}

/**
 * Check if a channel is authorized for bot usage.
 */
export function isChannelAllowed(channelId: string): boolean {
  if (config.allowedChannelIds.length === 0) return true
  return config.allowedChannelIds.includes(channelId)
}
