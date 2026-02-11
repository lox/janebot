import { createSign } from "crypto"
import * as log from "./logger.js"

interface InstallationToken {
  token: string
  expires_at: string
}

let cachedToken: InstallationToken | null = null

function createJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  })).toString("base64url")

  const sign = createSign("RSA-SHA256")
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(privateKey, "base64url")

  return `${header}.${payload}.${signature}`
}

async function mintInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<InstallationToken> {
  const jwt = createJWT(appId, privateKey)

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub App token mint failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<InstallationToken>
}

export async function getGitHubToken(): Promise<string | undefined> {
  const appId = process.env.GITHUB_APP_ID
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n")
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID

  if (!appId || !privateKey || !installationId) {
    return undefined
  }

  if (cachedToken) {
    const expiresAt = new Date(cachedToken.expires_at).getTime()
    const bufferMs = 5 * 60 * 1000
    if (Date.now() < expiresAt - bufferMs) {
      return cachedToken.token
    }
  }

  log.info("Minting GitHub App installation token", { appId, installationId })
  cachedToken = await mintInstallationToken(appId, privateKey, installationId)
  log.info("GitHub App token minted", { expires_at: cachedToken.expires_at })

  return cachedToken.token
}
