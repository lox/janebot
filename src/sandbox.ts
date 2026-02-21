/**
 * SandboxClient interface — abstraction over container backends.
 *
 * Provides container lifecycle, command execution, checkpoint/restore,
 * and file access. Implementations live in sprites.ts and docker-sandbox.ts.
 */

import { createHash } from "crypto"

export interface SandboxInfo {
  id: string
  name: string
  status: "cold" | "warm" | "running"
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SandboxCheckpoint {
  id: string
  comment?: string
}

export interface SandboxNetworkPolicyRule {
  action: "allow" | "deny"
  domain: string
}

export interface SandboxExecOptions {
  env?: Record<string, string>
  dir?: string
  stdin?: string
  timeoutMs?: number
  maxRetries?: number
}

export interface SandboxClient {
  /** Path to the pi binary inside the sandbox */
  readonly piBin: string
  /** Default PATH for commands in the sandbox */
  readonly defaultPath: string
  /** Path to npm binary inside the sandbox */
  readonly npmBin: string

  get(name: string): Promise<SandboxInfo | null>
  create(name: string): Promise<SandboxInfo>
  delete(name: string): Promise<void>
  exec(name: string, command: string[], options?: SandboxExecOptions): Promise<SandboxExecResult>
  downloadFile(name: string, path: string): Promise<Buffer>
  list(prefix?: string): Promise<SandboxInfo[]>
  listCheckpoints(name: string): Promise<SandboxCheckpoint[]>
  createCheckpoint(name: string, comment?: string): Promise<string>
  restoreCheckpoint(name: string, checkpointId: string): Promise<void>
  setNetworkPolicy(name: string, rules: SandboxNetworkPolicyRule[]): Promise<void>
}

/**
 * Generate a deterministic sandbox name from a Slack thread.
 */
export function getSandboxName(channelId: string, threadTs: string): string {
  const hash = createHash("sha256")
    .update(`${channelId}:${threadTs}`)
    .digest("hex")
    .slice(0, 12)
  return `jane-${hash}`
}

// Global singleton — set once at startup via initSandboxClient().
let _client: SandboxClient | undefined

export function initSandboxClient(client: SandboxClient): void {
  _client = client
}

export function getSandboxClient(): SandboxClient {
  if (!_client) throw new Error("Sandbox client not initialised")
  return _client
}
