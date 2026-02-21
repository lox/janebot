/**
 * Docker-based SandboxClient implementation.
 *
 * Uses local Docker daemon to run containers. Checkpoints use `docker commit`
 * to save state as images and `docker rm` + `docker run` to restore.
 *
 * Network policy is a no-op — containers have full network access.
 */

import { spawn } from "node:child_process"
import * as log from "./logger.js"
import type {
  SandboxClient,
  SandboxInfo,
  SandboxCheckpoint,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxNetworkPolicyRule,
} from "./sandbox.js"

const DOCKER_IMAGE = process.env.DOCKER_SANDBOX_IMAGE ?? "ghcr.io/buildkite/janebot-sandbox:latest"

export class DockerSandboxClient implements SandboxClient {
  readonly piBin = "/usr/local/bin/pi"
  readonly npmBin = "/usr/local/bin/npm"
  readonly defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  readonly homeDir = "/root"

  private async docker(
    args: string[],
    options?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutMs = options?.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: "pipe" })
      let stdout = ""
      let stderr = ""
      let resolved = false

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          child.kill("SIGTERM")
          reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })

      child.on("close", (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve({ stdout, stderr, exitCode: code ?? 1 })
        }
      })
    })
  }

  async get(name: string): Promise<SandboxInfo | null> {
    const result = await this.docker(
      ["inspect", "--format", "{{.State.Status}}", name],
      { timeoutMs: 10000 }
    )
    if (result.exitCode !== 0) return null
    const status = result.stdout.trim()
    return {
      id: name,
      name,
      status: status === "running" ? "running" : "cold",
    }
  }

  async create(name: string): Promise<SandboxInfo> {
    log.info("Creating Docker container", { name })
    const result = await this.docker(
      ["run", "-d", "--name", name, DOCKER_IMAGE, "sleep", "infinity"],
      { timeoutMs: 60000 }
    )
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create Docker container ${name}: ${result.stderr}`)
    }
    return { id: name, name, status: "running" }
  }

  async delete(name: string): Promise<void> {
    log.info("Deleting Docker container", { name })
    await this.docker(["rm", "-f", name], { timeoutMs: 10000 })
  }

  async exec(
    name: string,
    command: string[],
    options: SandboxExecOptions = {}
  ): Promise<SandboxExecResult> {
    const maxRetries = options.maxRetries ?? 1
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.execOnce(name, command, options)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt >= maxRetries) throw lastError
        const delayMs = Math.pow(2, attempt - 1) * 1000
        log.info("Retrying Docker exec", { name, attempt, maxRetries, delayMs })
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }

    throw lastError ?? new Error("exec failed")
  }

  private async execOnce(
    name: string,
    command: string[],
    options: SandboxExecOptions = {}
  ): Promise<SandboxExecResult> {
    const args: string[] = ["exec"]

    if (options.stdin !== undefined) {
      args.push("-i")
    }
    if (options.dir) {
      args.push("-w", options.dir)
    }
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`)
      }
    }

    args.push(name, ...command)

    const timeoutMs = options.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: "pipe" })
      let stdout = ""
      let stderr = ""
      let resolved = false

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          child.kill("SIGTERM")
          reject(new Error(`Docker exec timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })

      child.on("close", (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolve({ stdout, stderr, exitCode: code ?? 1 })
        }
      })

      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin)
      }
      child.stdin.end()
    })
  }

  async downloadFile(name: string, path: string): Promise<Buffer> {
    const result = await this.exec(name, ["base64", path])
    if (result.exitCode !== 0) {
      throw new Error(`Failed to download file ${path}: ${result.stderr}`)
    }
    return Buffer.from(result.stdout.trim(), "base64")
  }

  async list(prefix?: string): Promise<SandboxInfo[]> {
    const filter = prefix ? `name=${prefix}` : "name=jane-"
    const result = await this.docker(
      ["ps", "-a", "--filter", filter, "--format", "{{.Names}}\t{{.State}}"]
    )
    if (result.exitCode !== 0 || !result.stdout.trim()) return []

    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [name, state] = line.split("\t")
        return {
          id: name,
          name,
          status: (state === "running" ? "running" : "cold") as SandboxInfo["status"],
        }
      })
  }

  async listCheckpoints(name: string): Promise<SandboxCheckpoint[]> {
    const result = await this.docker(["images", "--format", "{{.Tag}}", name])
    if (result.exitCode !== 0 || !result.stdout.trim()) return []

    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((tag) => ({ id: tag, comment: tag }))
  }

  async createCheckpoint(name: string, comment?: string): Promise<string> {
    const tag = comment ?? `ckpt-${Date.now()}`
    log.info("Creating Docker checkpoint (commit)", { name, tag })
    const result = await this.docker(["commit", name, `${name}:${tag}`], {
      timeoutMs: 120000,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Docker commit failed: ${result.stderr}`)
    }
    log.info("Docker checkpoint created", { name, tag })
    return tag
  }

  async restoreCheckpoint(name: string, checkpointId: string): Promise<void> {
    log.info("Restoring Docker checkpoint", { name, checkpointId })
    await this.docker(["rm", "-f", name], { timeoutMs: 10000 })

    const result = await this.docker(
      ["run", "-d", "--name", name, `${name}:${checkpointId}`, "sleep", "infinity"],
      { timeoutMs: 60000 }
    )
    if (result.exitCode !== 0) {
      throw new Error(`Docker restore failed: ${result.stderr}`)
    }
    log.info("Docker checkpoint restored", { name, checkpointId })
  }

  async setNetworkPolicy(
    _name: string,
    _rules: SandboxNetworkPolicyRule[]
  ): Promise<void> {
    // No-op — Docker containers have full network access
  }
}
