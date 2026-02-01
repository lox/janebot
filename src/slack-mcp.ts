/**
 * Slack MCP Server - Exposes Slack operations as MCP tools.
 *
 * This runs as an HTTP endpoint on janebot and can be consumed by
 * Sprites or other MCP clients via Streamable HTTP transport.
 */

import express, { Request, Response, NextFunction } from "express"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { WebClient } from "@slack/web-api"
import * as log from "./logger.js"

// Session transports
const transports: Record<string, StreamableHTTPServerTransport> = {}

/**
 * Create the MCP server with Slack tools.
 */
function createSlackMcpServer(slackClient: WebClient): McpServer {
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
        // Resolve channel name to ID if needed
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

        // Get user info for display names
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

        // Format messages
        const formatted = result.messages
          .reverse() // Oldest first
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
        const result = await slackClient.conversations.list({
          limit,
          types,
        })

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
        // Search requires a user token, bot tokens don't have search scope
        if (msg.includes("missing_scope") || msg.includes("not_allowed")) {
          return {
            content: [
              {
                type: "text",
                text: "Search not available - requires a user token with search:read scope",
              },
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
        // Extract user ID from mention format <@U123>
        let userId = user
        const mentionMatch = user.match(/<@([A-Z0-9]+)>/)
        if (mentionMatch) {
          userId = mentionMatch[1]
        } else if (user.startsWith("@")) {
          // Look up by username
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
        // Resolve channel name to ID if needed
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

  return server
}

/**
 * Bearer token authentication middleware.
 */
function bearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" })
      return
    }
    const token = authHeader.slice(7)
    if (token !== expectedToken) {
      res.status(403).json({ error: "Invalid token" })
      return
    }
    next()
  }
}

/**
 * Create Express router for the Slack MCP endpoint.
 */
export function createSlackMcpRouter(slackClient: WebClient, authToken: string): express.Router {
  const router = express.Router()
  router.use(express.json())
  router.use(bearerAuth(authToken))

  // POST - main MCP communication
  router.post("/", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined

    try {
      // Reuse existing transport if session exists
      if (sessionId && transports[sessionId]) {
        const transport = transports[sessionId]
        await transport.handleRequest(req, res, req.body)
        return
      }

      // New session - check if it's an initialize request
      if (isInitializeRequest(req.body)) {
        const newSessionId = randomUUID()
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (id) => {
            transports[id] = transport
            log.info("Slack MCP session started", { sessionId: id })
          },
        })

        const server = createSlackMcpServer(slackClient)
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      }

      // Non-initialize request without valid session
      res.status(400).json({ error: "Invalid or missing session" })
    } catch (error) {
      log.error("Slack MCP POST error", error)
      res.status(500).json({ error: "Internal server error" })
    }
  })

  // GET - SSE stream for server-to-client notifications
  router.get("/", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "Invalid or missing session ID" })
      return
    }

    // Cleanup session on client disconnect (prevents memory leak)
    res.on("close", () => {
      const transport = transports[sessionId]
      if (transport) {
        transport.close().catch(() => {})
        delete transports[sessionId]
        log.info("Slack MCP session closed (client disconnect)", { sessionId })
      }
    })

    try {
      const transport = transports[sessionId]
      await transport.handleRequest(req, res)
    } catch (error) {
      log.error("Slack MCP GET error", error)
      res.status(500).json({ error: "Internal server error" })
    }
  })

  // DELETE - session termination
  router.delete("/", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined

    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: "Invalid or missing session ID" })
      return
    }

    try {
      const transport = transports[sessionId]
      await transport.close()
      delete transports[sessionId]
      log.info("Slack MCP session closed", { sessionId })
      res.status(200).json({ ok: true })
    } catch (error) {
      log.error("Slack MCP DELETE error", error)
      res.status(500).json({ error: "Internal server error" })
    }
  })

  return router
}
