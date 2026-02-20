import { createHash, randomUUID } from "crypto"
import { config } from "./config.js"
import { getGitHubToken } from "./github-app.js"
import * as log from "./logger.js"
import { parsePiOutput, type GeneratedFile } from "./sprite-executor.js"
import { getSandboxClient, getSandboxName, type SandboxClient, type SandboxNetworkPolicyRule } from "./sandbox.js"

const WORK_DIR = "/home/sprite/workspace"
const ARTIFACTS_DIR = "/home/sprite/artifacts"
const SESSIONS_DIR = "/home/sprite/sessions"

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SPRITE_EXEC_TIMEOUT_MS || "", 10)
const EXEC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : DEFAULT_EXEC_TIMEOUT_MS

const NETWORK_POLICY: SandboxNetworkPolicyRule[] = [
  { action: "allow", domain: "registry.npmjs.org" },
  { action: "allow", domain: "*.npmjs.org" },
  { action: "allow", domain: "*.npmjs.com" },
  { action: "allow", domain: "storage.googleapis.com" },
  { action: "allow", domain: "*.storage.googleapis.com" },
  { action: "allow", domain: "api.anthropic.com" },
  { action: "allow", domain: "api.openai.com" },
  { action: "allow", domain: "*.cloudflare.com" },
  { action: "allow", domain: "*.googleapis.com" },
  { action: "allow", domain: "github.com" },
  { action: "allow", domain: "*.github.com" },
  { action: "allow", domain: "api.github.com" },
  { action: "allow", domain: "raw.githubusercontent.com" },
  { action: "allow", domain: "objects.githubusercontent.com" },
]

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

async function ensureSpriteReady(client: SandboxClient, spriteName: string): Promise<void> {
  if (readySprites.has(spriteName)) return

  log.debug("Ensuring sprite is ready", { sprite: spriteName })
  const existing = await client.get(spriteName)
  if (!existing) {
    log.info("Creating coding subagent sprite", { sprite: spriteName })
    await client.create(spriteName)
  } else {
    log.debug("Found existing sprite", { sprite: spriteName, status: existing.status })
  }

  // Apply egress policy before bootstrap so installs don't depend on permissive defaults.
  await client.setNetworkPolicy(spriteName, NETWORK_POLICY)

  // Ensure required binaries and working directories exist.
  await client.exec(spriteName, [
    "bash", "-c",
    [
      `if [ ! -x "${client.piBin}" ]; then npm_config_update_notifier=false "${client.npmBin}" install -g --no-audit --no-fund @mariozechner/pi-coding-agent@0.52.9; fi`,
      `mkdir -p ${WORK_DIR} ${ARTIFACTS_DIR} ${SESSIONS_DIR}`,
    ].join(" && "),
  ], {
    timeoutMs: 600000,
  })

  readySprites.add(spriteName)
  log.info("Coding subagent sprite ready", { sprite: spriteName })
}

async function ensureSession(
  client: SandboxClient,
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
  const spriteName = getSandboxName(channelId, threadTs)

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
  client: SandboxClient,
  session: SubagentSession,
  systemPrompt: string | undefined
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: client.defaultPath,
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

  if (systemPrompt) {
    const agentsContent = systemPrompt.replace(/'/g, "'\\''")
    await client.exec(session.spriteName, [
      "bash", "-c", `printf '%s' '${agentsContent}' > /home/sprite/AGENTS.md`,
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

async function collectArtifacts(client: SandboxClient, session: SubagentSession): Promise<GeneratedFile[]> {
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
  client: SandboxClient,
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
  const args: string[] = [client.piBin, "--mode", "json", "--session", session.piSessionFile]

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

function rehydrateSession(channelId: string, threadTs: string): SubagentSession {
  const threadKey = makeThreadKey(channelId, threadTs)
  const subagentSessionId = makeSubagentSessionId(threadKey)
  const spriteName = getSandboxName(channelId, threadTs)

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
  log.debug("Rehydrated subagent session from deterministic keys", { subagentSessionId, spriteName })

  return session
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
  const client = getSandboxClient()

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
    let session = resolveSessionFromInput(input)
    if (!session && input.channelId && input.threadTs) {
      const sprite = await client.get(getSandboxName(input.channelId, input.threadTs))
      if (sprite) {
        session = rehydrateSession(input.channelId, input.threadTs)
      }
    }
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
    let session = resolveSessionFromInput(input)
    if (!session && input.channelId && input.threadTs) {
      const sprite = await client.get(getSandboxName(input.channelId, input.threadTs))
      if (sprite) {
        session = rehydrateSession(input.channelId, input.threadTs)
      }
    }
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
