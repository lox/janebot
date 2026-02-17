import { createHash, randomUUID } from "crypto"
import { config } from "./config.js"
import { FirecrackerClient } from "./firecracker.js"
import { getGitHubToken } from "./github-app.js"
import * as log from "./logger.js"
import { parsePiOutput, type GeneratedFile } from "./sprite-executor.js"

const SUBAGENT_PATH = process.env.SUBAGENT_PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const WORK_DIR = process.env.FIRECRACKER_WORK_DIR ?? "/workspace"
const ARTIFACTS_DIR = process.env.FIRECRACKER_ARTIFACTS_DIR ?? `${WORK_DIR}/artifacts`
const SESSIONS_DIR = process.env.FIRECRACKER_SESSIONS_DIR ?? `${WORK_DIR}/sessions`
const PI_CMD = process.env.SUBAGENT_PI_CMD ?? "pi"
const NODE_VERSION = process.env.FIRECRACKER_NODE_VERSION ?? "v22.22.0"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SPRITE_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_EXEC_TIMEOUT_MS

type SessionStatus = "idle" | "running" | "error"

interface SubagentSession {
  id: string
  key: string
  spriteName: string
  piSessionFile: string
  status: SessionStatus
  runningJobId?: string
  lastJobId?: string
  lastError?: string
  turns: number
  createdAt: number
  updatedAt: number
}

const sessionsByKey = new Map<string, SubagentSession>()
const sessionsById = new Map<string, SubagentSession>()
const readySprites = new Set<string>()
const firecrackerClient = new FirecrackerClient()

function makeThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`
}

function makeSubagentSessionId(threadKey: string): string {
  const hash = createHash("sha256").update(threadKey).digest("hex").slice(0, 16)
  return `sa_${hash}`
}

function makeJobId(): string {
  return `job_${randomUUID().slice(0, 8)}`
}

function getSessionByThread(channelId: string, threadTs: string): SubagentSession | undefined {
  return sessionsByKey.get(makeThreadKey(channelId, threadTs))
}

function getSessionById(subagentSessionId: string): SubagentSession | undefined {
  return sessionsById.get(subagentSessionId)
}

async function ensureSpriteReady(client: FirecrackerClient, spriteName: string): Promise<void> {
  if (readySprites.has(spriteName)) return

  log.debug("Ensuring Firecracker VM is ready", { vm: spriteName })
  const existing = await client.get(spriteName)
  if (!existing) {
    log.info("Creating coding subagent Firecracker VM", { vm: spriteName })
    await client.create(spriteName)
  } else {
    log.debug("Found existing subagent VM", { vm: spriteName, status: existing.status })
  }

  // Ensure required binaries and working directories exist.
  await client.exec(spriteName, [
    "bash", "-c",
    [
      [
        "need_node=1",
        "if command -v node >/dev/null 2>&1; then",
        "  major=$(node -v | sed -E 's/^v([0-9]+).*/\\1/')",
        "  if [ \"$major\" -ge 20 ]; then need_node=0; fi",
        "fi",
        "if [ \"$need_node\" -eq 1 ]; then",
        "  arch=$(uname -m)",
        "  case \"$arch\" in x86_64) narch=x64 ;; aarch64) narch=arm64 ;; *) echo unsupported:$arch; exit 1 ;; esac",
        `  ver=${NODE_VERSION}`,
        "  tmp=$(mktemp -d)",
        "  trap 'rm -rf \"$tmp\"' EXIT",
        "  curl -fsSL \"https://nodejs.org/dist/${ver}/node-${ver}-linux-${narch}.tar.xz\" -o \"$tmp/node.tar.xz\"",
        "  rm -rf \"/opt/node-${ver}\"",
        "  mkdir -p \"/opt/node-${ver}\"",
        "  tar -xJf \"$tmp/node.tar.xz\" -C \"/opt/node-${ver}\" --strip-components=1",
        "  ln -sf \"/opt/node-${ver}/bin/node\" /usr/local/bin/node",
        "  ln -sf \"/opt/node-${ver}/bin/npm\" /usr/local/bin/npm",
        "  ln -sf \"/opt/node-${ver}/bin/npx\" /usr/local/bin/npx",
        "fi",
      ].join(" && "),
      [
        `if ! command -v ${PI_CMD} >/dev/null 2>&1; then`,
        "  npm_config_update_notifier=false npm install -g --no-audit --no-fund @mariozechner/pi-coding-agent@0.52.9",
        "  npm_global_prefix=$(npm prefix -g)",
        `  ln -sf \"$npm_global_prefix/bin/${PI_CMD}\" /usr/local/bin/${PI_CMD}`,
        "fi",
      ].join(" && "),
      `mkdir -p ${WORK_DIR} ${ARTIFACTS_DIR} ${SESSIONS_DIR}`,
    ].join(" && "),
  ], {
    timeoutMs: 600000,
  })

  readySprites.add(spriteName)
  log.info("Coding subagent Firecracker VM ready", { vm: spriteName })
}

async function ensureSession(
  client: FirecrackerClient,
  channelId: string,
  threadTs: string
): Promise<{ session: SubagentSession; created: boolean }> {
  const threadKey = makeThreadKey(channelId, threadTs)
  const existing = sessionsByKey.get(threadKey)
  if (existing) {
    log.debug("Reusing subagent session", { subagentSessionId: existing.id, sprite: existing.spriteName })
    return { session: existing, created: false }
  }

  const subagentSessionId = makeSubagentSessionId(threadKey)
  const spriteName = FirecrackerClient.getVmName(channelId, threadTs)

  await ensureSpriteReady(client, spriteName)

  const session: SubagentSession = {
    id: subagentSessionId,
    key: threadKey,
    spriteName,
    piSessionFile: `${SESSIONS_DIR}/${subagentSessionId}.jsonl`,
    status: "idle",
    turns: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  sessionsByKey.set(threadKey, session)
  sessionsById.set(subagentSessionId, session)
  log.debug("Created subagent session", { subagentSessionId, sprite: spriteName, threadKey })

  return { session, created: true }
}

async function prepareSpriteRun(
  client: FirecrackerClient,
  session: SubagentSession,
  systemPrompt: string | undefined
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: SUBAGENT_PATH,
    HOME: "/root",
    NO_COLOR: "1",
    TERM: "dumb",
    CI: "true",
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable not set")
  }
  env.ANTHROPIC_API_KEY = anthropicKey

  if (systemPrompt) {
    const agentsContent = systemPrompt.replace(/'/g, "'\\''")
    await client.exec(session.spriteName, [
      "bash", "-c", `printf '%s' '${agentsContent}' > ${WORK_DIR}/AGENTS.md`,
    ], {
      timeoutMs: 30000,
      dir: WORK_DIR,
    })
  }

  await client.exec(session.spriteName, [
    "bash", "-c", `rm -rf ${ARTIFACTS_DIR} && mkdir -p ${ARTIFACTS_DIR}`,
  ], {
    timeoutMs: 10000,
    dir: WORK_DIR,
  })

  const githubToken = await getGitHubToken().catch((err) => {
    log.warn("Failed to mint GitHub token for subagent", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  })

  if (githubToken) {
    env.GH_TOKEN = githubToken
  }

  if (config.gitAuthorName || config.gitAuthorEmail) {
    const parts: string[] = []
    if (config.gitAuthorName) {
      parts.push(`git config --global user.name '${config.gitAuthorName.replace(/'/g, "'\\''")}'`)
    }
    if (config.gitAuthorEmail) {
      parts.push(`git config --global user.email '${config.gitAuthorEmail.replace(/'/g, "'\\''")}'`)
    }
    if (parts.length > 0) {
      await client.exec(session.spriteName, ["bash", "-c", parts.join(" && ")], {
        timeoutMs: 10000,
        dir: WORK_DIR,
      })
    }
  }

  return env
}

async function collectArtifacts(client: FirecrackerClient, session: SubagentSession): Promise<GeneratedFile[]> {
  const generatedFiles: GeneratedFile[] = []
  const artifactResult = await client.exec(session.spriteName,
    ["find", ARTIFACTS_DIR, "-type", "f", "-maxdepth", "2", "-size", "-10M"],
    {
      timeoutMs: 10000,
      dir: WORK_DIR,
    })

  const artifactPaths = artifactResult.stdout.trim().split("\n").filter(Boolean)
  for (const artifactPath of artifactPaths.slice(0, 10)) {
    if (artifactPath.includes("..")) {
      log.warn("Skipping artifact with suspicious path", { path: artifactPath })
      continue
    }
    const filename = artifactPath.split("/").pop() ?? "file"
    let data: Buffer | undefined
    try {
      data = await client.downloadFile(session.spriteName, artifactPath)
    } catch (err) {
      log.warn("Failed to download artifact", {
        path: artifactPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    generatedFiles.push({ path: artifactPath, filename, data })
  }

  return generatedFiles
}

async function sendMessageToSubagent(
  client: FirecrackerClient,
  session: SubagentSession,
  message: string,
  systemPrompt: string | undefined
): Promise<{ content: string; generatedFiles: GeneratedFile[]; jobId: string }> {
  await ensureSpriteReady(client, session.spriteName)
  log.debug("Sending message to coding subagent", {
    subagentSessionId: session.id,
    sprite: session.spriteName,
    messagePreview: message.slice(0, 120),
  })

  const env = await prepareSpriteRun(client, session, systemPrompt)
  const args: string[] = [PI_CMD, "--mode", "json", "--session", session.piSessionFile]

  if (config.piModel) {
    args.push("--model", config.piModel)
  }
  if (config.piThinkingLevel && config.piThinkingLevel !== "off") {
    args.push("--thinking", config.piThinkingLevel)
  }

  const jobId = makeJobId()
  session.runningJobId = jobId
  session.status = "running"
  session.updatedAt = Date.now()

  const result = await client.exec(session.spriteName, args, {
    env,
    stdin: message + "\n",
    timeoutMs: EXEC_TIMEOUT_MS,
    dir: WORK_DIR,
  })

  if (result.exitCode !== 0) {
    const stderr = result.stderr.slice(0, 500)
    throw new Error(`Pi exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`)
  }

  const { content } = parsePiOutput(result.stdout)
  const generatedFiles = await collectArtifacts(client, session)
  log.debug("Subagent run completed", {
    subagentSessionId: session.id,
    jobId,
    artifactCount: generatedFiles.length,
  })

  session.lastJobId = jobId
  session.runningJobId = undefined
  session.status = "idle"
  session.turns += 1
  session.updatedAt = Date.now()

  return {
    content: content || "Done.",
    generatedFiles,
    jobId,
  }
}

export interface RunCodingSubagentStartInput {
  action: "start"
  channelId: string
  threadTs: string
}

export interface RunCodingSubagentMessageInput {
  action: "message"
  message: string
  channelId?: string
  threadTs?: string
  subagentSessionId?: string
  systemPrompt?: string
}

export interface RunCodingSubagentStatusInput {
  action: "status"
  channelId?: string
  threadTs?: string
  subagentSessionId?: string
}

export interface RunCodingSubagentAbortInput {
  action: "abort"
  channelId?: string
  threadTs?: string
  subagentSessionId?: string
}

export type RunCodingSubagentInput =
  | RunCodingSubagentStartInput
  | RunCodingSubagentMessageInput
  | RunCodingSubagentStatusInput
  | RunCodingSubagentAbortInput

export interface RunCodingSubagentResult {
  subagentSessionId?: string
  jobId?: string
  status: "idle" | "running" | "completed" | "aborted" | "not_found" | "error"
  created?: boolean
  content?: string
  spriteName?: string
  generatedFiles: GeneratedFile[]
}

function resolveSessionFromInput(
  input:
    | RunCodingSubagentMessageInput
    | RunCodingSubagentStatusInput
    | RunCodingSubagentAbortInput
): SubagentSession | undefined {
  if (input.subagentSessionId) {
    return getSessionById(input.subagentSessionId)
  }
  if (input.channelId && input.threadTs) {
    return getSessionByThread(input.channelId, input.threadTs)
  }
  return undefined
}

export async function runCodingSubagent(
  input: RunCodingSubagentInput
): Promise<RunCodingSubagentResult> {
  log.debug("runCodingSubagent invoked", { action: input.action })
  const client = firecrackerClient

  if (input.action === "start") {
    const { session, created } = await ensureSession(client, input.channelId, input.threadTs)
    return {
      subagentSessionId: session.id,
      status: session.status,
      created,
      spriteName: session.spriteName,
      generatedFiles: [],
    }
  }

  if (input.action === "status") {
    const session = resolveSessionFromInput(input)
    if (!session) {
      return { status: "not_found", generatedFiles: [] }
    }
    return {
      subagentSessionId: session.id,
      jobId: session.runningJobId || session.lastJobId,
      status: session.status,
      spriteName: session.spriteName,
      generatedFiles: [],
    }
  }

  if (input.action === "abort") {
    const session = resolveSessionFromInput(input)
    if (!session) {
      return { status: "not_found", generatedFiles: [] }
    }

    await client.exec(session.spriteName, ["pkill", "-f", "pi"], {
      timeoutMs: 10000,
      maxRetries: 1,
      dir: WORK_DIR,
    }).catch(() => {
      // Ignore if there is nothing to kill.
    })

    session.runningJobId = undefined
    session.status = "idle"
    session.updatedAt = Date.now()

    return {
      subagentSessionId: session.id,
      status: "aborted",
      spriteName: session.spriteName,
      generatedFiles: [],
    }
  }

  const existing = resolveSessionFromInput(input)
  let session = existing
  let created = false

  if (!session) {
    if (!input.channelId || !input.threadTs) {
      throw new Error("message action requires subagentSessionId or channelId/threadTs")
    }
    const createdResult = await ensureSession(client, input.channelId, input.threadTs)
    session = createdResult.session
    created = createdResult.created
  }

  if (session.status === "running") {
    return {
      subagentSessionId: session.id,
      jobId: session.runningJobId,
      status: "running",
      spriteName: session.spriteName,
      generatedFiles: [],
      content: "A coding job is already running for this thread.",
    }
  }

  try {
    const result = await sendMessageToSubagent(client, session, input.message, input.systemPrompt)
    return {
      subagentSessionId: session.id,
      jobId: result.jobId,
      status: "completed",
      created,
      content: result.content,
      spriteName: session.spriteName,
      generatedFiles: result.generatedFiles,
    }
  } catch (err) {
    session.status = "error"
    session.lastError = err instanceof Error ? err.message : String(err)
    session.runningJobId = undefined
    session.updatedAt = Date.now()
    throw err
  }
}
