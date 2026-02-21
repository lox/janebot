#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const INPUT_FILES = [
  "Dockerfile.sandbox",
  "scripts/bootstrap-sandbox.sh",
]

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "..")

const hash = createHash("sha256")

for (const relPath of INPUT_FILES) {
  const absPath = resolve(REPO_ROOT, relPath)
  const content = readFileSync(absPath)
  hash.update(`${relPath}\n`)
  hash.update(content)
  hash.update("\n")
}

const short = hash.digest("hex").slice(0, 16)
process.stdout.write(`sbox-${short}\n`)
