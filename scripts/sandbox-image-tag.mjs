#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const INPUT_FILES = [
  "Dockerfile.sandbox",
  "scripts/bootstrap-sandbox.sh",
]

const hash = createHash("sha256")

for (const relPath of INPUT_FILES) {
  const absPath = resolve(process.cwd(), relPath)
  const content = readFileSync(absPath)
  hash.update(`${relPath}\n`)
  hash.update(content)
  hash.update("\n")
}

const short = hash.digest("hex").slice(0, 16)
process.stdout.write(`sbox-${short}\n`)
