/**
 * Simple structured logger for janebot.
 */

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
}

type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function getLogLevel(): LogLevel {
  const raw = (process.env.JANE_LOG_LEVEL || "").trim().toLowerCase()
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw
  }
  return "info"
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_VALUE[level] >= LEVEL_VALUE[getLogLevel()]
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function debug(message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog("debug")) return
  const metaStr = meta ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}` : ""
  console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}[debug]${COLORS.reset} ${message}${metaStr}`)
}

export function info(message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog("info")) return
  const metaStr = meta ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}` : ""
  console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${message}${metaStr}`)
}

export function warn(message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog("warn")) return
  const metaStr = meta ? ` ${COLORS.dim}${JSON.stringify(meta)}${COLORS.reset}` : ""
  console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}${metaStr}`)
}

export function error(message: string, err?: unknown): void {
  if (!shouldLog("error")) return
  const errStr = err instanceof Error ? `: ${err.message}` : err ? `: ${err}` : ""
  console.error(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}${message}${errStr}${COLORS.reset}`)
}

export function request(
  type: "mention" | "dm",
  user: string,
  channel: string,
  prompt: string
): void {
  if (!shouldLog("info")) return
  const preview = prompt.length > 50 ? prompt.slice(0, 50) + "..." : prompt
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}←${COLORS.reset} ${type} from ${user} in ${channel}: "${preview}"`
  )
}

export function response(
  type: "mention" | "dm",
  user: string,
  durationMs: number,
  success: boolean
): void {
  if (!shouldLog("info")) return
  const status = success
    ? `${COLORS.green}✓${COLORS.reset}`
    : `${COLORS.red}✗${COLORS.reset}`
  console.log(
    `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}→${COLORS.reset} ${type} to ${user} ${status} ${COLORS.dim}(${formatDuration(durationMs)})${COLORS.reset}`
  )
}

export function startup(config: {
  workspace: string
  piModel: string
  debounce: number
  hasSoul: boolean
  execution: string
  sessionDbPath?: string
}): void {
  if (!shouldLog("info")) return
  console.log(`
${COLORS.cyan}⚡ janebot${COLORS.reset}
   workspace: ${config.workspace}
   piModel: ${config.piModel}
   debounce: ${config.debounce}ms
   soul: ${config.hasSoul ? "loaded" : "none"}
   execution: ${config.execution}
   session_db: ${config.sessionDbPath || "disabled"}
`)
}
