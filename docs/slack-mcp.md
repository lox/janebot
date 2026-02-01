# Slack MCP Server

janebot includes a built-in MCP (Model Context Protocol) server that exposes Slack operations as tools. This allows agents to read Slack channels, search messages, and look up user/channel info.

## Transport Modes

janebot uses different MCP transports depending on execution mode:

### Local Mode (stdio transport)

```
janebot process
    │
    └──▶ spawns slack-mcp-stdio.ts ──▶ Slack API
```

For local execution (`ALLOW_LOCAL_EXECUTION=true`), the Amp SDK spawns the MCP server as a subprocess using stdio transport. No network configuration needed.

### Sprites Mode (HTTP transport)

```
Sprite VM                         Fly.io (janebot)
    │                                   │
    │  POST /mcp/slack                  │
    │  Authorization: Bearer <token>    │
    └──────────────────────────────────▶ Slack MCP ──▶ Slack API
```

For Sprites execution, the MCP server runs as an HTTP endpoint. Sprites connect via HTTPS with bearer token auth.

## Configuration

### Local Mode

No extra configuration needed. Just set `ALLOW_LOCAL_EXECUTION=true` and have `SLACK_BOT_TOKEN` set. The stdio MCP server is automatically configured.

### Sprites Mode (Fly.io)

```bash
# Generate a secure token
fly secrets set SLACK_MCP_TOKEN=$(openssl rand -hex 32)

# Set the public URL for the MCP endpoint
fly secrets set SLACK_MCP_URL=https://your-app.fly.dev/mcp/slack

# Port for the MCP HTTP server (default: 3000, Fly uses 8080 internally)
MCP_PORT=3000
```

## Available Tools

### read_channel

Read recent messages from a Slack channel.

**Parameters:**
- `channel` (string): Channel ID (e.g., `C1234567890`) or channel name (e.g., `#general`)
- `limit` (number, 1-100, default: 20): Number of messages to fetch

**Example:**
```
Read the last 10 messages from #chat-ai
```

### list_channels

List Slack channels the bot has access to.

**Parameters:**
- `limit` (number, 1-200, default: 50): Max channels to list
- `types` (string, default: `public_channel,private_channel`): Channel types to include

### search_messages

Search for messages in Slack.

**Parameters:**
- `query` (string): Search query
- `count` (number, 1-100, default: 20): Number of results

**Note:** Requires a user token with `search:read` scope. Bot tokens cannot search.

### get_user

Get information about a Slack user.

**Parameters:**
- `user` (string): User ID (e.g., `U1234567890`), @mention, or @username

### get_channel

Get information about a Slack channel.

**Parameters:**
- `channel` (string): Channel ID or `#channel-name`

## How It Works

### Local Mode

When running locally (including REPL with `--local`), janebot configures the Amp SDK with an stdio-based MCP server:

```typescript
mcpConfig: {
  slack: {
    command: process.execPath,  // Full path to node
    args: ["node_modules/tsx/dist/cli.mjs", "scripts/slack-mcp-stdio.ts"],
    env: { SLACK_BOT_TOKEN: "..." }
  }
}
```

The SDK spawns this as a subprocess - no ports, no network configuration. The REPL automatically includes Slack MCP when `SLACK_BOT_TOKEN` is set in `.env`.

### Sprites Mode

janebot writes MCP config to `/home/sprite/.config/amp/settings.json` before each Amp execution:

```json
{
  "amp.mcpServers": {
    "slack": {
      "url": "https://janebot.fly.dev/mcp/slack",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Token rotation is automatic - each Sprite execution gets the current token.

## Security

- HTTP endpoint requires bearer token authentication
- Stdio server inherits SLACK_BOT_TOKEN from parent process
- Only read operations exposed (no posting, editing, or deleting)
- Bot can only access channels it's been invited to
- All HTTP requests logged with session IDs
