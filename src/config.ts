import "dotenv/config"
import { fileURLToPath } from "url"
import { createRequire } from "module"

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface JanebotConfig {
  // Amp settings
  workspaceDir: string
  agentMode: "smart" | "rush" | "deep"

  // Behavior
  debounceMs: number
  maxResponseLength: number

  // Authorization (empty arrays = allow all)
  allowedUserIds: string[]
  allowedChannelIds: string[]

  // MCP servers
  mcpServers: Record<string, McpServerConfig>

  // Sprites (required for sandboxed execution)
  spritesToken: string | undefined

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

function parseMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  const mcpConfig = process.env.MCP_SERVERS

  if (!mcpConfig) return servers

  // Format: "name1:command1:arg1,arg2;name2:command2:arg1"
  for (const entry of mcpConfig.split(";")) {
    const [name, command, ...args] = entry.split(":")
    if (name && command) {
      servers[name.trim()] = {
        command: command.trim(),
        args: args.length > 0 ? args[0].split(",").map((a) => a.trim()) : undefined,
      }
    }
  }

  return servers
}

function buildMcpServers(): Record<string, McpServerConfig> {
  const servers = parseMcpServers()

  // Add Slack MCP server for local execution mode (stdio transport)
  // For Sprites mode, the HTTP server is configured in sprite-executor.ts
  if (process.env.ALLOW_LOCAL_EXECUTION === "true" && process.env.SLACK_BOT_TOKEN) {
    servers.slack = getSlackMcpConfig()!
  }

  return servers
}

/**
 * Get Slack MCP config for stdio transport (local execution).
 * Returns undefined if SLACK_BOT_TOKEN is not set.
 */
export function getSlackMcpConfig(): McpServerConfig | undefined {
  if (!process.env.SLACK_BOT_TOKEN) return undefined

  // Use require.resolve for tsx (handles various node_modules layouts)
  // and fileURLToPath for local script (handles spaces, special chars, Windows)
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve("tsx/dist/cli.mjs")
  const mcpScript = fileURLToPath(new URL("../scripts/slack-mcp-stdio.ts", import.meta.url))

  return {
    command: process.execPath, // Full path to current node binary
    args: [tsxCli, mcpScript],
    // Inherit parent env to preserve PATH, then add/override SLACK_BOT_TOKEN
    env: {
      ...process.env,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    },
  }
}

export const config: JanebotConfig = {
  workspaceDir: process.env.WORKSPACE_DIR ?? process.cwd(),
  agentMode: (process.env.AGENT_MODE ?? "smart") as "smart" | "rush" | "deep",
  debounceMs: parseInt(process.env.DEBOUNCE_MS ?? "1500", 10),
  maxResponseLength: parseInt(process.env.MAX_RESPONSE_LENGTH ?? "10000", 10),
  allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
  allowedChannelIds: parseList(process.env.ALLOWED_CHANNEL_IDS),
  mcpServers: buildMcpServers(),
  spritesToken: process.env.SPRITES_TOKEN,
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
