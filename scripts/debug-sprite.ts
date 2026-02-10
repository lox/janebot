#!/usr/bin/env npx tsx
import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

const token = process.env.SPRITES_TOKEN
const ampKey = process.env.AMP_API_KEY
if (!token || !ampKey) {
  console.error("SPRITES_TOKEN and AMP_API_KEY required")
  process.exit(1)
}

const AMP_BIN = "/home/sprite/.amp/bin/amp"
const client = new SpritesClient(token)
const name = "jane-debug-test"

async function main() {
  console.log("Creating sprite...")
  await client.create(name)
  console.log("Created")

  await client.setNetworkPolicy(name, [
    { action: "allow", domain: "ampcode.com" },
    { action: "allow", domain: "*.ampcode.com" },
    { action: "allow", domain: "storage.googleapis.com" },
    { action: "allow", domain: "*.storage.googleapis.com" },
    { action: "allow", domain: "api.anthropic.com" },
    { action: "allow", domain: "api.openai.com" },
    { action: "allow", domain: "*.cloudflare.com" },
    { action: "allow", domain: "*.googleapis.com" },
  ])
  console.log("Network policy set")

  console.log("Installing amp...")
  const install = await client.exec(name, [
    "bash", "-c", "curl -fsSL https://ampcode.com/install.sh | bash",
  ], { timeoutMs: 120000 })
  console.log("Install exit:", install.exitCode)

  const ver = await client.exec(name, [AMP_BIN, "--version"])
  console.log("Amp version:", ver.stdout.trim())

  // Test DNS
  const dns = await client.exec(name, [
    "bash", "-c", "getent hosts api.ampcode.com || echo DNS_FAILED",
  ])
  console.log("DNS api.ampcode.com:", dns.stdout.trim())

  // Write settings
  const settings = JSON.stringify({
    "amp.permissions": [{ tool: "*", action: "allow" }],
  })
  await client.exec(name, [
    "bash", "-c", `cat > /tmp/amp-settings.json << 'SETTINGS_EOF'\n${settings}\nSETTINGS_EOF`,
  ])
  console.log("Settings written")

  // Verify settings
  const cat = await client.exec(name, ["cat", "/tmp/amp-settings.json"])
  console.log("Settings content:", cat.stdout.trim())

  // Run amp with librarian
  console.log("Running amp with librarian test...")
  const result = await client.exec(name, [
    AMP_BIN,
    "--execute", "--stream-json",
    "--dangerously-allow-all",
    "--mode", "smart",
    "--log-level", "warn",
    "--settings-file", "/tmp/amp-settings.json",
  ], {
    env: {
      PATH: `/home/sprite/.amp/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: "/home/sprite",
      NO_COLOR: "1",
      TERM: "dumb",
      CI: "true",
      AMP_API_KEY: ampKey,
    },
    stdin: "use the librarian to tell me what lox/janebot is\n",
    timeoutMs: 120000,
  })

  console.log("Exit code:", result.exitCode)
  if (result.stderr) console.log("Stderr:", result.stderr.slice(0, 500))

  const lines = result.stdout.split("\n").filter(l => l.trim())
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      if (msg.type === "result") {
        console.log("Result subtype:", msg.subtype)
        if (msg.error) console.log("Error:", msg.error)
        if (msg.result) console.log("Result:", msg.result.slice(0, 300))
      }
    } catch {}
  }

  await client.delete(name)
  console.log("Cleaned up")
}

main().catch(async (e) => {
  console.error(e)
  await client.delete(name).catch(() => {})
  process.exit(1)
})
