#!/usr/bin/env npx tsx
/**
 * Admin CLI for janebot operations.
 *
 * Locally:
 *   npx tsx scripts/admin.ts <command> [args]
 *
 * On Fly:
 *   fly ssh console --config fly.staging.toml -C "node dist/scripts/admin.js <command> [args]"
 *
 * Commands:
 *   runners              List all runner sprites and their status
 *   runners:delete       Delete all runner sprites (forces rebuild on next deploy)
 *   sprites [prefix]     List all sprites with optional prefix filter
 *   sprites:delete <prefix>  Delete sprites matching prefix
 */

import "dotenv/config"
import { SpritesClient } from "../src/sprites.js"

function getClient(): SpritesClient {
  const token = process.env.SPRITES_TOKEN
  if (!token) {
    console.error("SPRITES_TOKEN not set")
    process.exit(1)
  }
  return new SpritesClient(token)
}

async function listRunners() {
  const client = getClient()
  const sprites = await client.list("jane-runner-")
  console.log(`Found ${sprites.length} runner(s):`)
  for (const s of sprites) {
    const checkpoints = await client.listCheckpoints(s.name)
    const cpInfo = checkpoints.map((c) => `${c.id} (${c.comment || "no comment"})`).join(", ")
    console.log(`  ${s.name}  status=${s.status}  checkpoints=[${cpInfo}]`)
  }
}

async function deleteRunners() {
  const client = getClient()
  const sprites = await client.list("jane-runner-")
  if (sprites.length === 0) {
    console.log("No runners to delete")
    return
  }
  console.log(`Deleting ${sprites.length} runner(s)...`)
  for (const s of sprites) {
    await client.delete(s.name)
    console.log(`  deleted ${s.name}`)
  }
  console.log("Done. Runners will rebuild on next startup.")
}

async function listSprites(prefix: string) {
  const client = getClient()
  const sprites = await client.list(prefix)
  console.log(`Found ${sprites.length} sprite(s) with prefix "${prefix}":`)
  for (const s of sprites) {
    console.log(`  ${s.name}  status=${s.status}`)
  }
}

async function deleteSprites(prefix: string) {
  if (!prefix || prefix.length < 3) {
    console.error("Prefix must be at least 3 characters (safety check)")
    process.exit(1)
  }
  const client = getClient()
  const sprites = await client.list(prefix)
  if (sprites.length === 0) {
    console.log(`No sprites matching prefix "${prefix}"`)
    return
  }
  console.log(`Deleting ${sprites.length} sprite(s) matching "${prefix}"...`)
  for (const s of sprites) {
    await client.delete(s.name)
    console.log(`  deleted ${s.name}`)
  }
  console.log("Done")
}

async function showHelp() {
  console.log(`Usage: admin <command> [args]

Commands:
  runners              List runner sprites and their checkpoints
  runners:delete       Delete all runners (forces rebuild on restart)
  sprites [prefix]     List sprites (default prefix: "jane-")
  sprites:delete <prefix>  Delete sprites matching prefix
  help                 Show this help`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case "runners":
      return listRunners()
    case "runners:delete":
      return deleteRunners()
    case "sprites":
      return listSprites(args[0] || "jane-")
    case "sprites:delete":
      if (!args[0]) {
        console.error("Usage: admin sprites:delete <prefix>")
        process.exit(1)
      }
      return deleteSprites(args[0])
    case "help":
    case undefined:
      return showHelp()
    default:
      console.error(`Unknown command: ${command}`)
      await showHelp()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
