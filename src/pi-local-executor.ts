import { spawn } from "node:child_process"
import { access, readdir, readFile, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { parsePiOutput, type GeneratedFile } from "./sandbox-executor.js"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.LOCAL_PI_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_EXEC_TIMEOUT_MS

interface ExecuteLocalPiOptions {
  prompt: string
  systemPrompt?: string
  workspaceDir: string
  piModel?: string
  piThinkingLevel?: string
}

export interface LocalPiExecutionResult {
  content: string
  threadId: string | undefined
  generatedFiles: GeneratedFile[]
}

async function pathExistsAndExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolvePiBinary(workspaceDir: string): Promise<string> {
  const configured = process.env.PI_BIN?.trim()
  if (configured) {
    return configured
  }

  const candidates = [
    join(workspaceDir, "node_modules", ".bin", "pi"),
    join(process.cwd(), "node_modules", ".bin", "pi"),
  ]

  for (const candidate of candidates) {
    if (await pathExistsAndExecutable(candidate)) {
      return candidate
    }
  }

  return "pi"
}

async function runPiCommand(
  binary: string,
  args: string[],
  options: { cwd: string; prompt: string; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`Local Pi execution timed out after ${EXEC_TIMEOUT_MS}ms`))
    }, EXEC_TIMEOUT_MS)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })

    child.on("close", (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 })
    })

    child.stdin.write(options.prompt + "\n")
    child.stdin.end()
  })
}

async function collectLocalArtifacts(workspaceDir: string, minMtimeMs: number): Promise<GeneratedFile[]> {
  const candidates = [join(workspaceDir, "artifacts"), "/home/sprite/artifacts"]
  const out: GeneratedFile[] = []
  const seen = new Set<string>()
  const MAX_FILES = 10
  const MAX_BYTES = 10 * 1024 * 1024

  for (const baseDir of candidates) {
    let topLevel: string[]
    try {
      topLevel = await readdir(baseDir, { withFileTypes: false })
    } catch {
      continue
    }

    const queue: string[] = []
    for (const entry of topLevel) {
      queue.push(join(baseDir, entry))
    }

    while (queue.length > 0 && out.length < MAX_FILES) {
      const current = queue.shift()!

      let fileStat
      try {
        fileStat = await stat(current)
      } catch {
        continue
      }

      if (fileStat.isDirectory()) {
        const parts = current.slice(baseDir.length).split("/").filter(Boolean)
        if (parts.length >= 2) continue
        let children: string[]
        try {
          children = await readdir(current, { withFileTypes: false })
        } catch {
          continue
        }
        for (const child of children) {
          queue.push(join(current, child))
        }
        continue
      }

      if (!fileStat.isFile() || fileStat.size > MAX_BYTES) continue
      if (fileStat.mtimeMs < minMtimeMs) continue
      if (seen.has(current)) continue

      try {
        const data = await readFile(current)
        out.push({
          path: current,
          filename: current.split("/").pop() ?? "file",
          data,
        })
        seen.add(current)
      } catch {
        // Ignore unreadable files
      }
    }
  }

  return out
}

export async function executeLocalPi(
  options: ExecuteLocalPiOptions
): Promise<LocalPiExecutionResult> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable not set")
  }

  const binary = await resolvePiBinary(options.workspaceDir)
  const args = ["--mode", "json", "--no-session"]

  if (options.piModel) {
    args.push("--model", options.piModel)
  }
  if (options.piThinkingLevel && options.piThinkingLevel !== "off") {
    args.push("--thinking", options.piThinkingLevel)
  }

  const fullPrompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n## User Request\n${options.prompt}`
    : options.prompt

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: anthropicKey,
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "true",
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  }

  let result: { stdout: string; stderr: string; exitCode: number }
  const startedAtMs = Date.now()
  try {
    result = await runPiCommand(binary, args, {
      cwd: options.workspaceDir,
      prompt: fullPrompt,
      env,
    })
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        "Pi CLI not found. Install dependencies with `pnpm install` or set PI_BIN to the Pi executable path."
      )
    }
    throw err
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.slice(0, 500)
    throw new Error(`Pi exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
  }

  const { content } = parsePiOutput(result.stdout)
  const generatedFiles = await collectLocalArtifacts(options.workspaceDir, startedAtMs)

  return {
    content: content || "Done.",
    threadId: undefined,
    generatedFiles,
  }
}
