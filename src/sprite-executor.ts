import { config } from "./config.js"
import * as log from "./logger.js"
import { acquireRunner } from "./sprite-runners.js"
import { getSandboxClient } from "./sandbox.js"
import { getGitHubToken } from "./github-app.js"

const DEBUG_PI_OUTPUT = process.env.DEBUG_PI_OUTPUT === "1"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "", 10)
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

export interface SandboxExecutorOptions {
  prompt: string
  systemPrompt?: string
  userId: string
}

export interface GeneratedFile {
  path: string
  filename: string
  data?: Buffer
}

export interface SandboxExecutorResult {
  content: string
  threadId: string | undefined
  sandboxName: string
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

export async function executeInSandbox(
  options: SandboxExecutorOptions
): Promise<SandboxExecutorResult> {
  const sandboxClient = getSandboxClient()
  const { name: sandboxName, release } = await acquireRunner()

  try {
    log.info("Acquired runner", { sandbox: sandboxName })

    const args: string[] = [sandboxClient.piBin, "--mode", "json", "--no-session"]
    if (config.piModel) {
      args.push("--model", config.piModel)
    }
    if (config.piThinkingLevel && config.piThinkingLevel !== "off") {
      args.push("--thinking", config.piThinkingLevel)
    }

    const env: Record<string, string> = {
      PATH: sandboxClient.defaultPath,
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

    // Run setup tasks in parallel: system prompt, artifacts dir, GitHub auth
    const setupTasks: Promise<void>[] = []

    // Write system prompt as AGENTS.md
    if (options.systemPrompt) {
      const agentsContent = options.systemPrompt.replace(/'/g, "'\\''")
      setupTasks.push(
        sandboxClient.exec(sandboxName, [
          "bash", "-c",
          `printf '%s' '${agentsContent}' > /home/sprite/AGENTS.md`,
        ], { timeoutMs: 30000 }).then(() => {})
      )
    }

    // Clean artifacts dir before each run
    setupTasks.push(
      sandboxClient.exec(sandboxName, [
        "bash", "-c",
        "rm -rf /home/sprite/artifacts && mkdir -p /home/sprite/artifacts",
      ], { timeoutMs: 10000 }).then(() => {})
    )

    // GitHub setup — mint token (cached) + configure in sandbox
    setupTasks.push((async () => {
      let githubToken: string | undefined
      try {
        githubToken = await getGitHubToken()
      } catch (err) {
        log.warn("Failed to mint GitHub token, continuing without GitHub access", { error: err })
      }
      if (githubToken) {
        // gh auth — pass token via stdin to avoid exposing in process list
        const authResult = await sandboxClient.exec(sandboxName, [
          "gh", "auth", "login", "--with-token",
        ], { stdin: githubToken, timeoutMs: 30000 })
        if (authResult.exitCode !== 0) {
          log.warn("GitHub auth failed", { exitCode: authResult.exitCode, stderr: authResult.stderr })
        } else {
          log.info("GitHub CLI authenticated in sandbox", { sandbox: sandboxName })
        }

        // git config — no secrets here, safe to combine
        const gitConfigParts: string[] = []
        if (config.gitAuthorName) {
          gitConfigParts.push(`git config --global user.name '${config.gitAuthorName.replace(/'/g, "'\\''")}'`)
        }
        if (config.gitAuthorEmail) {
          gitConfigParts.push(`git config --global user.email '${config.gitAuthorEmail.replace(/'/g, "'\\''")}'`)
        }
        if (gitConfigParts.length > 0) {
          await sandboxClient.exec(sandboxName, [
            "bash", "-c", gitConfigParts.join(" && "),
          ], { timeoutMs: 10000 })
        }
        // Set GH_TOKEN for Pi execution (gh CLI will also use stored creds)
        env.GH_TOKEN = githubToken
      }
    })())

    await Promise.all(setupTasks)

    log.info("Executing pi in sandbox", {
      sandbox: sandboxName,
      timeoutMs: EXEC_TIMEOUT_MS,
    })

    const result = await sandboxClient.exec(sandboxName, args, {
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

    if (result.exitCode !== 0) {
      const stderr = result.stderr.slice(0, 500)
      throw new Error(`Pi exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
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
    const artifactResult = await sandboxClient.exec(sandboxName,
      ["find", "/home/sprite/artifacts", "-type", "f", "-maxdepth", "2", "-size", "-10M"],
      { timeoutMs: 10000 })
    const artifactPaths = artifactResult.stdout.trim().split("\n").filter(Boolean)

    for (const artifactPath of artifactPaths.slice(0, 10)) {
      // Sanitise: no path traversal
      if (artifactPath.includes("..")) {
        log.warn("Skipping artifact with suspicious path", { path: artifactPath })
        continue
      }
      const filename = artifactPath.split("/").pop() ?? "file"
      // Download file data now, before the runner is released and checkpoint restored
      let data: Buffer | undefined
      try {
        data = await sandboxClient.downloadFile(sandboxName, artifactPath)
      } catch (err) {
        log.warn("Failed to download artifact", { path: artifactPath, error: err instanceof Error ? err.message : String(err) })
      }
      generatedFiles.push({ path: artifactPath, filename, data })
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
      sandboxName,
      generatedFiles,
    }
  } finally {
    await release()
    log.info("Released runner", { sandbox: sandboxName })
  }
}
