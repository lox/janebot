import { SpritesClient } from "./sprites.js"
import { config } from "./config.js"
import * as log from "./logger.js"
import { acquireRunner, PI_BIN } from "./sprite-runners.js"
import { getGitHubToken } from "./github-app.js"

const DEBUG_PI_OUTPUT = process.env.DEBUG_PI_OUTPUT === "1"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SPRITE_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_EXEC_TIMEOUT_MS

interface PiEvent {
  type: string
  [key: string]: unknown
}

interface PiAgentEndEvent extends PiEvent {
  type: "agent_end"
  messages: Array<{
    role: string
    content: Array<{ type: string; text?: string }>
    model?: string
  }>
}

interface PiMessageStartEvent extends PiEvent {
  type: "message_start"
  message: {
    role: string
    model?: string
    content: Array<{ type: string; text?: string }>
  }
}

export interface SpriteExecutorOptions {
  prompt: string
  systemPrompt?: string
  userId: string
}

export interface GeneratedFile {
  path: string
  filename: string
}

export interface SpriteExecutorResult {
  content: string
  threadId: string | undefined
  spriteName: string
  generatedFiles: GeneratedFile[]
}

export function parsePiOutput(stdout: string): {
  content: string
  model: string | undefined
} {
  if (DEBUG_PI_OUTPUT) {
    log.info("Raw pi stdout", { length: stdout.length, preview: stdout.slice(0, 2000) })
  }

  const events: PiEvent[] = []
  const lines = stdout.split("\n").filter((line) => line.trim())

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as PiEvent)
    } catch {
      // Non-JSON line — ignore
    }
  }

  // Extract final answer from agent_end.messages
  const agentEnd = events.find((e): e is PiAgentEndEvent => e.type === "agent_end")
  if (!agentEnd) {
    throw new Error("Pi execution failed: no agent_end event in output")
  }

  // Find the last assistant message with text content
  let content = ""
  for (let i = agentEnd.messages.length - 1; i >= 0; i--) {
    const msg = agentEnd.messages[i]
    if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
      if (textParts.length > 0) {
        content = textParts.join("\n")
        break
      }
    }
  }

  // Extract model from first assistant message_start
  const firstAssistant = events.find(
    (e): e is PiMessageStartEvent =>
      e.type === "message_start" &&
      (e as PiMessageStartEvent).message?.role === "assistant"
  )
  const model = firstAssistant?.message?.model

  return { content, model }
}

export async function executeInSprite(
  options: SpriteExecutorOptions
): Promise<SpriteExecutorResult> {
  const token = config.spritesToken
  if (!token) {
    throw new Error("SPRITES_TOKEN not configured")
  }

  const spritesClient = new SpritesClient(token)
  const { name: spriteName, release } = await acquireRunner()

  try {
    log.info("Acquired runner", { sprite: spriteName })

    // Write system prompt as AGENTS.md
    if (options.systemPrompt) {
      const agentsContent = options.systemPrompt.replace(/'/g, "'\\''")
      await spritesClient.exec(spriteName, [
        "bash", "-c",
        `printf '%s' '${agentsContent}' > /home/sprite/AGENTS.md`,
      ], { timeoutMs: 30000 })
    }

    // Clean artifacts dir before each run
    await spritesClient.exec(spriteName, [
      "bash", "-c",
      "rm -rf /home/sprite/artifacts && mkdir -p /home/sprite/artifacts",
    ], { timeoutMs: 10000 })

    const args: string[] = [PI_BIN, "--mode", "json", "--no-session"]
    if (config.piModel) {
      args.push("--model", config.piModel)
    }
    if (config.piThinkingLevel && config.piThinkingLevel !== "off") {
      args.push("--thinking", config.piThinkingLevel)
    }

    // Use the sprite's default PATH so Pi can find node
    const pathResult = await spritesClient.exec(spriteName, ["bash", "-c", "echo $PATH"], { timeoutMs: 10000 })
    const spritePath = pathResult.stdout.trim()

    const env: Record<string, string> = {
      PATH: spritePath,
      HOME: "/home/sprite",
      NO_COLOR: "1",
      TERM: "dumb",
      CI: "true",
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set")
    }
    env.ANTHROPIC_API_KEY = anthropicKey

    // Pass through other provider keys if set
    for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      const value = process.env[key]
      if (value) {
        env[key] = value
      }
    }

    let githubToken: string | undefined
    try {
      githubToken = await getGitHubToken()
    } catch (err) {
      log.warn("Failed to mint GitHub token, continuing without GitHub access", { error: err })
    }
    if (githubToken) {
      env.GH_TOKEN = githubToken
      await spritesClient.exec(spriteName, [
        "gh", "auth", "login", "--with-token",
      ], { env, stdin: githubToken, timeoutMs: 30000 })
      if (config.gitAuthorName) {
        const nameResult = await spritesClient.exec(spriteName, [
          "git", "config", "--global", "user.name", config.gitAuthorName,
        ], { timeoutMs: 10000 })
        if (nameResult.exitCode !== 0) {
          log.warn("Failed to set git user.name", { exitCode: nameResult.exitCode, stderr: nameResult.stderr })
        }
      }
      if (config.gitAuthorEmail) {
        const emailResult = await spritesClient.exec(spriteName, [
          "git", "config", "--global", "user.email", config.gitAuthorEmail,
        ], { timeoutMs: 10000 })
        if (emailResult.exitCode !== 0) {
          log.warn("Failed to set git user.email", { exitCode: emailResult.exitCode, stderr: emailResult.stderr })
        }
      }
      log.info("GitHub CLI and git identity configured in sprite", { sprite: spriteName })
    }

    log.info("Executing pi in sprite", {
      sprite: spriteName,
      timeoutMs: EXEC_TIMEOUT_MS,
    })

    const result = await spritesClient.exec(spriteName, args, {
      env,
      stdin: options.prompt + "\n",
      timeoutMs: EXEC_TIMEOUT_MS,
    })

    if (DEBUG_PI_OUTPUT) {
      log.info("Pi exec result", {
        exitCode: result.exitCode,
        stdoutLen: result.stdout.length,
        stderrLen: result.stderr.length,
        stderrPreview: result.stderr.slice(0, 500),
      })
    }

    const { content, model } = parsePiOutput(result.stdout)

    if (config.piModel && model && model !== config.piModel) {
      log.warn("Pi used different model than configured", {
        configured: config.piModel,
        actual: model,
      })
    }

    // Collect artifacts
    const generatedFiles: GeneratedFile[] = []
    const artifactResult = await spritesClient.exec(spriteName,
      ["find", "/home/sprite/artifacts", "-type", "f", "-maxdepth", "2"],
      { timeoutMs: 10000 })
    const artifactPaths = artifactResult.stdout.trim().split("\n").filter(Boolean)

    for (const artifactPath of artifactPaths.slice(0, 10)) {
      // Sanitise: no path traversal
      if (artifactPath.includes("..")) {
        log.warn("Skipping artifact with suspicious path", { path: artifactPath })
        continue
      }
      const filename = artifactPath.split("/").pop() ?? "file"
      generatedFiles.push({ path: artifactPath, filename })
    }

    if (generatedFiles.length > 0) {
      const fileSummary = generatedFiles.map(f => ({
        path: f.path,
        filename: f.filename,
      }))
      log.info("Found generated files", { count: generatedFiles.length, files: fileSummary })
    }

    return {
      content: content || "Done.",
      threadId: undefined,
      spriteName,
      generatedFiles,
    }
  } finally {
    await release()
    log.info("Released runner", { sprite: spriteName })
  }
}
