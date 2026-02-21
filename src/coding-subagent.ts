import { createHash, randomUUID } from "crypto"
import { config } from "./config.js"
import { getGitHubToken } from "./github-app.js"
import * as log from "./logger.js"
import { parsePiOutput, type GeneratedFile } from "./sandbox-executor.js"
import { getSandboxClient, getSandboxName, type SandboxClient, type SandboxNetworkPolicyRule } from "./sandbox.js"
import { getSessionStore, type PersistedSubagentSession } from "./session-store.js"

function workDir(client: SandboxClient): string { return `${client.homeDir}/workspace` }
function artifactsDir(client: SandboxClient): string { return `${client.homeDir}/artifacts` }
function sessionsDir(client: SandboxClient): string { return `${client.homeDir}/sessions` }
function ghLocalBinDir(client: SandboxClient): string { return `${client.homeDir}/.local/bin` }

const DEFAULT_EXEC_TIMEOUT_MS = 600000
const parsedTimeout = parseInt(process.env.SANDBOX_EXEC_TIMEOUT_MS || "", 10)
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
  channelId: string
  threadTs: string
  sandboxName: string
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
const readySandboxes = new Set<string>()

function ghInstallScript(binDir: string): string {
  return [
    `if ! command -v gh >/dev/null 2>&1 && [ ! -x "${binDir}/gh" ]; then`,
    "  set -euo pipefail",
    "  arch=$(uname -m)",
    "  case \"$arch\" in",
    "    x86_64|amd64) gh_arch=\"amd64\" ;;",
    "    aarch64|arm64) gh_arch=\"arm64\" ;;",
    "    *) echo \"Unsupported architecture for gh: $arch\" >&2; exit 1 ;;",
    "  esac",
    "  gh_tag=$(node -e 'const url = \"https://api.github.com/repos/cli/cli/releases/latest\"; fetch(url).then(async (res) => { if (!res.ok) throw new Error(String(res.status)); const body = await res.json(); process.stdout.write(body.tag_name || \"\"); }).catch((err) => { console.error(err.message); process.exit(1); });')",
    "  if [ -z \"$gh_tag\" ]; then",
    "    echo \"Unable to resolve gh release tag\" >&2",
    "    exit 1",
    "  fi",
    "  tmp_dir=$(mktemp -d)",
    "  trap 'rm -rf \"$tmp_dir\"' EXIT",
    "  curl -fsSL \"https://github.com/cli/cli/releases/download/${gh_tag}/gh_${gh_tag#v}_linux_${gh_arch}.tar.gz\" -o \"$tmp_dir/gh.tgz\"",
    "  tar -xzf \"$tmp_dir/gh.tgz\" -C \"$tmp_dir\"",
    `  mkdir -p ${binDir}`,
    "  install \"$tmp_dir/gh_${gh_tag#v}_linux_${gh_arch}/bin/gh\" " + `${binDir}/gh`,
    "fi",
  ].join("\n")
}

async function ensureGhInstalled(
  client: SandboxClient,
  sandboxName: string,
  context: "bootstrap" | "runtime"
): Promise<boolean> {
  const ghExists = await client.exec(sandboxName, [
    "bash",
    "-c",
    `if command -v gh >/dev/null 2>&1 || [ -x "${ghLocalBinDir(client)}/gh" ]; then exit 0; fi; exit 1`,
  ], {
    timeoutMs: 10000,
  })
  if (ghExists.exitCode === 0) {
    return true
  }

  const ghSetup = await client.exec(sandboxName, [
    "bash",
    "-c",
    ghInstallScript(ghLocalBinDir(client)),
  ], {
    timeoutMs: 600000,
  })
  if (ghSetup.exitCode !== 0) {
    log.warn("Failed to install gh in subagent sandbox", {
      sandbox: sandboxName,
      context,
      exitCode: ghSetup.exitCode,
      stderr: ghSetup.stderr || ghSetup.stdout,
    })
    return false
  }

  return true
}

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
  const threadKey = makeThreadKey(channelId, threadTs)
  const cached = sessionsByKey.get(threadKey)
  if (cached) return cached

  try {
    const persisted = getSessionStore().getByThread(channelId, threadTs)
    if (!persisted) return undefined
    const session = cacheSession(mapPersistedSession(persisted))
    log.debug("Loaded subagent session from SQLite by thread", {
      subagentSessionId: session.id,
      sandbox: session.sandboxName,
      threadKey,
    })
    return session
  } catch (err) {
    log.warn("Failed to load subagent session from SQLite by thread", {
      threadKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

function getSessionById(subagentSessionId: string): SubagentSession | undefined {
  const cached = sessionsById.get(subagentSessionId)
  if (cached) return cached

  try {
    const persisted = getSessionStore().getById(subagentSessionId)
    if (!persisted) return undefined
    const session = cacheSession(mapPersistedSession(persisted))
    log.debug("Loaded subagent session from SQLite by id", {
      subagentSessionId: session.id,
      sandbox: session.sandboxName,
      threadKey: session.key,
    })
    return session
  } catch (err) {
    log.warn("Failed to load subagent session from SQLite by id", {
      subagentSessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

function cacheSession(session: SubagentSession): SubagentSession {
  sessionsByKey.set(session.key, session)
  sessionsById.set(session.id, session)
  return session
}

function mapPersistedSession(persisted: PersistedSubagentSession): SubagentSession {
  return {
    id: persisted.id,
    key: persisted.key,
    channelId: persisted.channelId,
    threadTs: persisted.threadTs,
    sandboxName: persisted.sandboxName,
    piSessionFile: persisted.piSessionFile,
    status: persisted.status,
    runningJobId: persisted.runningJobId,
    lastJobId: persisted.lastJobId,
    lastError: persisted.lastError,
    turns: persisted.turns,
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
  }
}

function persistSession(session: SubagentSession): void {
  try {
    getSessionStore().upsert({
      id: session.id,
      key: session.key,
      channelId: session.channelId,
      threadTs: session.threadTs,
      sandboxName: session.sandboxName,
      piSessionFile: session.piSessionFile,
      status: session.status,
      runningJobId: session.runningJobId,
      lastJobId: session.lastJobId,
      lastError: session.lastError,
      turns: session.turns,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    })
  } catch (err) {
    log.warn("Failed to persist subagent session to SQLite", {
      subagentSessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function ensureSandboxReady(client: SandboxClient, sandboxName: string): Promise<void> {
  if (readySandboxes.has(sandboxName)) return

  log.debug("Ensuring sandbox is ready", { sandbox: sandboxName })
  const existing = await client.get(sandboxName)
  if (!existing) {
    log.info("Creating coding subagent sandbox", { sandbox: sandboxName })
    await client.create(sandboxName)
  } else {
    log.debug("Found existing sandbox", { sandbox: sandboxName, status: existing.status })
  }

  // Apply egress policy before bootstrap so installs don't depend on permissive defaults.
  await client.setNetworkPolicy(sandboxName, NETWORK_POLICY)

  // Ensure required binaries and working directories exist.
  const coreSetup = await client.exec(sandboxName, [
    "bash", "-c",
    [
      `if [ ! -x "${client.piBin}" ]; then npm_config_update_notifier=false "${client.npmBin}" install -g --no-audit --no-fund @mariozechner/pi-coding-agent@0.52.9; fi`,
      `mkdir -p ${workDir(client)} ${artifactsDir(client)} ${sessionsDir(client)} ${ghLocalBinDir(client)}`,
    ].join(" && "),
  ], {
    timeoutMs: 600000,
  })
  if (coreSetup.exitCode !== 0) {
    throw new Error(`Failed to bootstrap subagent sandbox core dependencies: ${coreSetup.stderr || coreSetup.stdout}`)
  }

  // gh install is optional at bootstrap; runtime will retry when GH auth is needed.
  await ensureGhInstalled(client, sandboxName, "bootstrap")

  readySandboxes.add(sandboxName)
  log.info("Coding subagent sandbox ready", { sandbox: sandboxName })
}

async function ensureSession(
  client: SandboxClient,
  channelId: string,
  threadTs: string
): Promise<{ session: SubagentSession; created: boolean }> {
  const threadKey = makeThreadKey(channelId, threadTs)
  const existing = getSessionByThread(channelId, threadTs)
  if (existing) {
    log.debug("Reusing subagent session", { subagentSessionId: existing.id, sandbox: existing.sandboxName })
    return { session: existing, created: false }
  }

  const subagentSessionId = makeSubagentSessionId(threadKey)
  const sandboxName = getSandboxName(channelId, threadTs)

  await ensureSandboxReady(client, sandboxName)

  const session: SubagentSession = {
    id: subagentSessionId,
    key: threadKey,
    channelId,
    threadTs,
    sandboxName,
    piSessionFile: `${sessionsDir(client)}/${subagentSessionId}.jsonl`,
    status: "idle",
    turns: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  cacheSession(session)
  persistSession(session)
  log.debug("Created subagent session", { subagentSessionId, sandbox: sandboxName, threadKey })

  return { session, created: true }
}

async function prepareSandboxRun(
  client: SandboxClient,
  session: SubagentSession,
  systemPrompt: string | undefined
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    PATH: `${client.defaultPath}:${ghLocalBinDir(client)}`,
    HOME: client.homeDir,
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
    await client.exec(session.sandboxName, [
      "bash", "-c", `printf '%s' '${agentsContent}' > ${client.homeDir}/AGENTS.md`,
    ], {
      timeoutMs: 30000,
      dir: workDir(client),
    })
  }

  await client.exec(session.sandboxName, [
    "bash", "-c", `rm -rf ${artifactsDir(client)} && mkdir -p ${artifactsDir(client)}`,
  ], {
    timeoutMs: 10000,
    dir: workDir(client),
  })

  const githubToken = await getGitHubToken().catch((err) => {
    log.warn("Failed to mint GitHub token for subagent", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  })

  if (githubToken) {
    const ghAuthEnv = {
      PATH: env.PATH,
      HOME: env.HOME,
    }
    const hasGh = await ensureGhInstalled(client, session.sandboxName, "runtime")
    if (hasGh) {
      const authResult = await client.exec(session.sandboxName, [
        "gh", "auth", "login", "--hostname", "github.com", "--with-token",
      ], {
        env: ghAuthEnv,
        stdin: `${githubToken}\n`,
        timeoutMs: 30000,
        dir: workDir(client),
      })
      if (authResult.exitCode !== 0) {
        log.warn("GitHub auth failed for subagent", {
          sandbox: session.sandboxName,
          exitCode: authResult.exitCode,
          stderr: authResult.stderr || authResult.stdout,
        })
      } else {
        const setupGitResult = await client.exec(session.sandboxName, [
          "gh", "auth", "setup-git", "--hostname", "github.com",
        ], {
          env: ghAuthEnv,
          timeoutMs: 30000,
          dir: workDir(client),
        })
        if (setupGitResult.exitCode !== 0) {
          log.warn("GitHub git credential setup failed for subagent", {
            sandbox: session.sandboxName,
            exitCode: setupGitResult.exitCode,
            stderr: setupGitResult.stderr || setupGitResult.stdout,
          })
        } else {
          log.info("GitHub CLI authenticated and git credentials configured in subagent sandbox", {
            sandbox: session.sandboxName,
          })
        }
      }
    } else {
      log.warn("Skipping GitHub CLI auth because gh is unavailable in subagent sandbox", {
        sandbox: session.sandboxName,
      })
    }
    env.GH_TOKEN = githubToken
    const authResult = await client.exec(session.sandboxName, [
      "gh", "auth", "login", "--with-token",
    ], { stdin: githubToken, timeoutMs: 30000, env: { HOME: client.homeDir } })
    if (authResult.exitCode !== 0) {
      log.warn("gh auth login failed in subagent sandbox", { exitCode: authResult.exitCode, stderr: authResult.stderr })
    }
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
      await client.exec(session.sandboxName, ["bash", "-c", parts.join(" && ")], {
        timeoutMs: 10000,
        dir: workDir(client),
      })
    }
  }

  return env
}

async function collectArtifacts(client: SandboxClient, session: SubagentSession): Promise<GeneratedFile[]> {
  const generatedFiles: GeneratedFile[] = []
  const artifactResult = await client.exec(session.sandboxName,
    ["find", artifactsDir(client), "-type", "f", "-maxdepth", "2", "-size", "-10M"],
    {
      timeoutMs: 10000,
      dir: workDir(client),
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
      data = await client.downloadFile(session.sandboxName, artifactPath)
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

async function isSessionPiProcessRunning(client: SandboxClient, session: SubagentSession): Promise<boolean> {
  const escapedSessionPath = session.piSessionFile.replace(/'/g, "'\\''")
  const probeCommand = [
    "if command -v pgrep >/dev/null 2>&1; then",
    `  pgrep -af pi | grep -F -- '--session ${escapedSessionPath}' >/dev/null`,
    "else",
    `  session_arg='--session ${escapedSessionPath}'`,
    "  while read -r pid args; do",
    "    [ -z \"${pid:-}\" ] && continue",
    "    [ \"$pid\" = \"$$\" ] && continue",
    "    if [[ \"$args\" == *\"$session_arg\"* ]]; then",
    "      exit 0",
    "    fi",
    "  done < <(ps -eo pid=,args=)",
    "  exit 1",
    "fi",
  ].join(" ")

  try {
    const probe = await client.exec(session.sandboxName, ["bash", "-c", probeCommand], {
      timeoutMs: 10000,
      maxRetries: 1,
      dir: workDir(client),
    })
    return probe.exitCode === 0
  } catch (err) {
    log.warn("Failed to probe subagent process state", {
      subagentSessionId: session.id,
      sandbox: session.sandboxName,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

async function reconcileRunningSessionState(client: SandboxClient, session: SubagentSession): Promise<void> {
  if (session.status !== "running") return

  const stillRunning = await isSessionPiProcessRunning(client, session)
  if (stillRunning) return

  log.warn("Session marked running but no live pi process found; resetting to idle", {
    subagentSessionId: session.id,
    sandbox: session.sandboxName,
    runningJobId: session.runningJobId,
  })
  session.status = "idle"
  session.runningJobId = undefined
  session.updatedAt = Date.now()
  persistSession(session)
}

async function sendMessageToSubagent(
  client: SandboxClient,
  session: SubagentSession,
  message: string,
  systemPrompt: string | undefined
): Promise<{ content: string; generatedFiles: GeneratedFile[]; jobId: string }> {
  await ensureSandboxReady(client, session.sandboxName)
  log.debug("Sending message to coding subagent", {
    subagentSessionId: session.id,
    sandbox: session.sandboxName,
    messagePreview: message.slice(0, 120),
  })

  const env = await prepareSandboxRun(client, session, systemPrompt)
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
  persistSession(session)

  const result = await client.exec(session.sandboxName, args, {
    env,
    stdin: message + "\n",
    timeoutMs: EXEC_TIMEOUT_MS,
    dir: workDir(client),
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
  session.lastError = undefined
  session.status = "idle"
  session.turns += 1
  session.updatedAt = Date.now()
  persistSession(session)

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
  sandboxName?: string
  generatedFiles: GeneratedFile[]
}

function rehydrateSession(client: SandboxClient, channelId: string, threadTs: string): SubagentSession {
  const existing = getSessionByThread(channelId, threadTs)
  if (existing) return existing

  const threadKey = makeThreadKey(channelId, threadTs)
  const subagentSessionId = makeSubagentSessionId(threadKey)
  const sandboxName = getSandboxName(channelId, threadTs)

  const session: SubagentSession = {
    id: subagentSessionId,
    key: threadKey,
    channelId,
    threadTs,
    sandboxName,
    piSessionFile: `${sessionsDir(client)}/${subagentSessionId}.jsonl`,
    status: "idle",
    turns: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  cacheSession(session)
  persistSession(session)
  log.debug("Rehydrated subagent session from deterministic keys", { subagentSessionId, sandboxName })

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
      sandboxName: session.sandboxName,
      generatedFiles: [],
    }
  }

  if (input.action === "status") {
    let session = resolveSessionFromInput(input)
    if (!session && input.channelId && input.threadTs) {
      const sandbox = await client.get(getSandboxName(input.channelId, input.threadTs))
      if (sandbox) {
        session = rehydrateSession(client, input.channelId, input.threadTs)
      }
    }
    if (!session) {
      return { status: "not_found", generatedFiles: [] }
    }
    return {
      subagentSessionId: session.id,
      jobId: session.runningJobId || session.lastJobId,
      status: session.status,
      sandboxName: session.sandboxName,
      generatedFiles: [],
    }
  }

  if (input.action === "abort") {
    let session = resolveSessionFromInput(input)
    if (!session && input.channelId && input.threadTs) {
      const sandbox = await client.get(getSandboxName(input.channelId, input.threadTs))
      if (sandbox) {
        session = rehydrateSession(client, input.channelId, input.threadTs)
      }
    }
    if (!session) {
      return { status: "not_found", generatedFiles: [] }
    }

    await client.exec(session.sandboxName, ["pkill", "-f", "pi"], {
      timeoutMs: 10000,
      maxRetries: 1,
      dir: workDir(client),
    }).catch(() => {
      // Ignore if there is nothing to kill.
    })

    session.runningJobId = undefined
    session.status = "idle"
    session.updatedAt = Date.now()
    persistSession(session)

    return {
      subagentSessionId: session.id,
      status: "aborted",
      sandboxName: session.sandboxName,
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
    await reconcileRunningSessionState(client, session)
  }

  if (session.status === "running") {
    return {
      subagentSessionId: session.id,
      jobId: session.runningJobId,
      status: "running",
      sandboxName: session.sandboxName,
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
      sandboxName: session.sandboxName,
      generatedFiles: result.generatedFiles,
    }
  } catch (err) {
    session.status = "error"
    session.lastError = err instanceof Error ? err.message : String(err)
    session.runningJobId = undefined
    session.updatedAt = Date.now()
    persistSession(session)
    throw err
  }
}
