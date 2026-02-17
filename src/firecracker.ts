import { createHash } from "crypto"
import { spawn } from "child_process"
import * as log from "./logger.js"

export interface FirecrackerVmInfo {
  id: string
  name: string
  status: "cold" | "warm" | "running"
  created_at: string
  updated_at: string
}

export interface FirecrackerExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

function quoteShell(arg: string): string {
  if (arg.length === 0) return "''"
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function commandToShell(args: string[]): string {
  return args.map(quoteShell).join(" ")
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    stdin?: string
    timeoutMs?: number
    env?: Record<string, string>
  } = {}
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: "pipe",
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timeoutMs = options.timeoutMs ?? 300000

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`))
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8")
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      })
    })

    if (options.stdin) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

function getIgniteConfig() {
  return {
    image: process.env.FIRECRACKER_IGNITE_IMAGE ?? "weaveworks/ignite-ubuntu",
    cpus: process.env.FIRECRACKER_VM_CPUS ?? "2",
    memory: process.env.FIRECRACKER_VM_MEMORY ?? "4GB",
    diskSize: process.env.FIRECRACKER_VM_DISK_SIZE ?? "20GB",
  }
}

function buildRemoteCommand(
  command: string[],
  options: { env?: Record<string, string>; dir?: string }
): string {
  const prefix: string[] = []
  if (options.dir) {
    prefix.push(`cd ${quoteShell(options.dir)}`)
  }
  if (options.env && Object.keys(options.env).length > 0) {
    const envPart = Object.entries(options.env)
      .map(([key, value]) => `${key}=${quoteShell(value)}`)
      .join(" ")
    prefix.push(`export ${envPart}`)
  }

  const cmdPart = commandToShell(command)
  return [...prefix, cmdPart].join(" && ")
}

export class FirecrackerClient {
  async hostDiagnostics(): Promise<{ ignite: string; firecracker: string }> {
    const ignite = await runProcess("bash", ["-lc", "sudo ignite version 2>&1 | head -n 1"], {
      timeoutMs: 15000,
    })
    const firecracker = await runProcess("bash", ["-lc", "firecracker --version 2>&1 | head -n 1"], {
      timeoutMs: 15000,
    })

    return {
      ignite: (ignite.stdout || ignite.stderr).trim(),
      firecracker: (firecracker.stdout || firecracker.stderr).trim(),
    }
  }

  static getVmName(channelId: string, threadTs: string): string {
    const hash = createHash("sha256")
      .update(`${channelId}:${threadTs}`)
      .digest("hex")
      .slice(0, 12)
    return `jane-${hash}`
  }

  async get(name: string): Promise<FirecrackerVmInfo | null> {
    const result = await runProcess("bash", [
      "-lc",
      `sudo ignite ps -a 2>/dev/null | awk 'NR>1 {print $NF}' | grep -Fx ${quoteShell(name)} || true`,
    ], { timeoutMs: 15000 })

    if (!result.stdout.trim()) {
      return null
    }

    const now = new Date().toISOString()
    return {
      id: name,
      name,
      status: "running",
      created_at: now,
      updated_at: now,
    }
  }

  async create(name: string): Promise<FirecrackerVmInfo> {
    const cfg = getIgniteConfig()
    log.info("Creating Firecracker VM for subagent", {
      name,
      image: cfg.image,
      cpus: cfg.cpus,
      memory: cfg.memory,
      diskSize: cfg.diskSize,
    })

    const createResult = await runProcess("sudo", [
      "ignite",
      "run",
      cfg.image,
      "--name", name,
      "--cpus", cfg.cpus,
      "--memory", cfg.memory,
      "--size", cfg.diskSize,
      "--ssh",
    ], { timeoutMs: 180000 })

    if (createResult.exitCode !== 0) {
      throw new Error(`ignite run failed (${createResult.exitCode}): ${createResult.stderr || createResult.stdout}`)
    }

    await this.waitUntilReady(name)
    const now = new Date().toISOString()
    return {
      id: name,
      name,
      status: "running",
      created_at: now,
      updated_at: now,
    }
  }

  async delete(name: string): Promise<void> {
    await runProcess("sudo", ["ignite", "rm", "-f", name], { timeoutMs: 30000 })
  }

  async setNetworkPolicy(_name: string, _rules: Array<{ action: "allow" | "deny"; domain: string }>): Promise<void> {
    // No-op for local Firecracker VMs in the first iteration.
  }

  async exec(
    name: string,
    command: string[],
    options: {
      env?: Record<string, string>
      dir?: string
      stdin?: string
      timeoutMs?: number
      maxRetries?: number
    } = {}
  ): Promise<FirecrackerExecResult> {
    const maxRetries = options.maxRetries ?? 1
    const remoteCommand = buildRemoteCommand(command, { env: options.env, dir: options.dir })

    let lastErr: Error | undefined
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await runProcess(
          "sudo",
          ["ignite", "exec", name, "--", "bash", "-lc", remoteCommand],
          {
            stdin: options.stdin,
            timeoutMs: options.timeoutMs,
          }
        )
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        if (attempt >= maxRetries) throw lastErr
      }
    }

    throw lastErr ?? new Error("ignite exec failed")
  }

  async downloadFile(name: string, path: string): Promise<Buffer> {
    const result = await this.exec(name, ["base64", "-w0", path], {
      timeoutMs: 30000,
      maxRetries: 1,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file from VM: ${result.stderr || result.stdout}`)
    }
    return Buffer.from(result.stdout.trim(), "base64")
  }

  private async waitUntilReady(name: string): Promise<void> {
    const deadline = Date.now() + 120000
    let lastError = ""
    while (Date.now() < deadline) {
      const probe = await runProcess("sudo", ["ignite", "exec", name, "--", "true"], {
        timeoutMs: 5000,
      })
      if (probe.exitCode === 0) return
      lastError = probe.stderr || probe.stdout
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`VM did not become ready in time: ${name}${lastError ? ` (${lastError.trim()})` : ""}`)
  }
}
