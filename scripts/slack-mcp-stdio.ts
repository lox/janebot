#!/usr/bin/env npx tsx
/**
 * Stdio-based Slack MCP server for local execution mode.
 *
 * This runs as a subprocess spawned by the Amp SDK when using local execution.
 * It provides the same Slack tools as the HTTP server but over stdio transport.
 *
 * Usage:
 *   npx tsx scripts/slack-mcp-stdio.ts
 *
 * The SLACK_BOT_TOKEN environment variable must be set.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebClient } from "@slack/web-api"
import { z } from "zod"

const slackToken = process.env.SLACK_BOT_TOKEN
if (!slackToken) {
  console.error("SLACK_BOT_TOKEN environment variable is required")
  process.exit(1)
}

const slackClient = new WebClient(slackToken)

const server = new McpServer(
  {
    name: "slack-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      logging: {},
      tools: { listChanged: false },
    },
  }
)

// Tool: Read channel history
server.tool(
  "read_channel",
  "Read recent messages from a Slack channel",
  {
    channel: z.string().describe("Channel ID (e.g., C1234567890) or channel name (e.g., #general)"),
    limit: z.number().min(1).max(100).default(20).describe("Number of messages to fetch (1-100)"),
  },
  async ({ channel, limit }) => {
    try {
      let channelId = channel
      if (channel.startsWith("#")) {
        const channelName = channel.slice(1)
        const listResult = await slackClient.conversations.list({ limit: 200 })
        const found = listResult.channels?.find(
          (c) => c.name === channelName || c.name_normalized === channelName
        )
        if (!found?.id) {
          return { content: [{ type: "text", text: `Channel "${channel}" not found` }] }
        }
        channelId = found.id
      }

      const result = await slackClient.conversations.history({
        channel: channelId,
        limit,
      })

      if (!result.messages || result.messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found in channel" }] }
      }

      const userIds = [...new Set(result.messages.map((m) => m.user).filter((u): u is string => !!u))]
      const userMap: Record<string, string> = {}
      for (const userId of userIds) {
        try {
          const userInfo = await slackClient.users.info({ user: userId })
          userMap[userId] = userInfo.user?.real_name || userInfo.user?.name || userId
        } catch {
          userMap[userId] = userId
        }
      }

      const formatted = result.messages
        .reverse()
        .map((m) => {
          const user = m.user ? userMap[m.user] || m.user : "unknown"
          const time = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : ""
          return `[${time}] ${user}: ${m.text || "(no text)"}`
        })
        .join("\n")

      return { content: [{ type: "text", text: formatted }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { content: [{ type: "text", text: `Error reading channel: ${msg}` }] }
    }
  }
)

// Tool: List channels
server.tool(
  "list_channels",
  "List Slack channels the bot has access to",
  {
    limit: z.number().min(1).max(200).default(50).describe("Max channels to list"),
    types: z
      .string()
      .default("public_channel,private_channel")
      .describe("Channel types: public_channel, private_channel, mpim, im"),
  },
  async ({ limit, types }) => {
    try {
      const result = await slackClient.conversations.list({ limit, types })

      if (!result.channels || result.channels.length === 0) {
        return { content: [{ type: "text", text: "No channels found" }] }
      }

      const formatted = result.channels
        .map((c) => {
          const prefix = c.is_private ? "🔒" : "#"
          const members = c.num_members ? ` (${c.num_members} members)` : ""
          return `${prefix}${c.name} - ${c.id}${members}`
        })
        .join("\n")

      return { content: [{ type: "text", text: formatted }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { content: [{ type: "text", text: `Error listing channels: ${msg}` }] }
    }
  }
)

// Tool: Search messages
server.tool(
  "search_messages",
  "Search for messages in Slack",
  {
    query: z.string().describe("Search query"),
    count: z.number().min(1).max(100).default(20).describe("Number of results"),
  },
  async ({ query, count }) => {
    try {
      const result = await slackClient.search.messages({
        query,
        count,
        sort: "timestamp",
        sort_dir: "desc",
      })

      const matches = result.messages?.matches
      if (!matches || matches.length === 0) {
        return { content: [{ type: "text", text: `No results for "${query}"` }] }
      }

      const formatted = matches
        .map((m) => {
          const channel = m.channel?.name ? `#${m.channel.name}` : "unknown"
          const user = m.username || m.user || "unknown"
          const time = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : ""
          return `[${time}] ${channel} - ${user}: ${m.text || "(no text)"}`
        })
        .join("\n\n")

      return { content: [{ type: "text", text: formatted }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes("missing_scope") || msg.includes("not_allowed")) {
        return {
          content: [
            { type: "text", text: "Search not available - requires a user token with search:read scope" },
          ],
        }
      }
      return { content: [{ type: "text", text: `Error searching: ${msg}` }] }
    }
  }
)

// Tool: Get user info
server.tool(
  "get_user",
  "Get information about a Slack user",
  {
    user: z.string().describe("User ID (e.g., U1234567890) or @mention"),
  },
  async ({ user }) => {
    try {
      let userId = user
      const mentionMatch = user.match(/<@([A-Z0-9]+)>/)
      if (mentionMatch) {
        userId = mentionMatch[1]
      } else if (user.startsWith("@")) {
        const listResult = await slackClient.users.list({ limit: 500 })
        const found = listResult.members?.find(
          (m) => m.name === user.slice(1) || m.profile?.display_name === user.slice(1)
        )
        if (!found?.id) {
          return { content: [{ type: "text", text: `User "${user}" not found` }] }
        }
        userId = found.id
      }

      const result = await slackClient.users.info({ user: userId })
      const u = result.user

      if (!u) {
        return { content: [{ type: "text", text: `User "${user}" not found` }] }
      }

      const info = [
        `Name: ${u.real_name || u.name}`,
        `Username: @${u.name}`,
        `ID: ${u.id}`,
        u.profile?.title ? `Title: ${u.profile.title}` : null,
        u.profile?.email ? `Email: ${u.profile.email}` : null,
        `Timezone: ${u.tz || "unknown"}`,
        `Status: ${u.profile?.status_emoji || ""} ${u.profile?.status_text || ""}`.trim() || null,
      ]
        .filter(Boolean)
        .join("\n")

      return { content: [{ type: "text", text: info }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { content: [{ type: "text", text: `Error getting user: ${msg}` }] }
    }
  }
)

// Tool: Get channel info
server.tool(
  "get_channel",
  "Get information about a Slack channel",
  {
    channel: z.string().describe("Channel ID or #channel-name"),
  },
  async ({ channel }) => {
    try {
      let channelId = channel
      if (channel.startsWith("#")) {
        const channelName = channel.slice(1)
        const listResult = await slackClient.conversations.list({ limit: 200 })
        const found = listResult.channels?.find(
          (c) => c.name === channelName || c.name_normalized === channelName
        )
        if (!found?.id) {
          return { content: [{ type: "text", text: `Channel "${channel}" not found` }] }
        }
        channelId = found.id
      }

      const result = await slackClient.conversations.info({ channel: channelId })
      const c = result.channel

      if (!c) {
        return { content: [{ type: "text", text: `Channel "${channel}" not found` }] }
      }

      const info = [
        `Name: #${c.name}`,
        `ID: ${c.id}`,
        c.purpose?.value ? `Purpose: ${c.purpose.value}` : null,
        c.topic?.value ? `Topic: ${c.topic.value}` : null,
        `Members: ${c.num_members || "unknown"}`,
        `Private: ${c.is_private ? "Yes" : "No"}`,
        `Archived: ${c.is_archived ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n")

      return { content: [{ type: "text", text: info }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { content: [{ type: "text", text: `Error getting channel: ${msg}` }] }
    }
  }
)

// Start the server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error("Slack MCP server error:", error)
  process.exit(1)
})
