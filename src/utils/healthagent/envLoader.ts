import { config as dotenvConfig } from 'dotenv'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

/**
 * Load .env files in precedence order:
 *   1. Shell env vars (already in process.env — always win, dotenv never overwrites)
 *   2. Local .env in cwd (project-level override)
 *   3. ~/.healthagent/.env (user-level default)
 *
 * Load local first, then global — dotenv skips vars already set, so local wins over global.
 */
export function loadHealthAgentEnv(): void {
  const localPath = resolve(process.cwd(), '.env')
  const globalPath = join(homedir(), '.healthagent', '.env')

  if (existsSync(localPath)) dotenvConfig({ path: localPath, quiet: true })
  if (existsSync(globalPath)) dotenvConfig({ path: globalPath, quiet: true })
}

/**
 * Validate that a usable model backend is configured.
 * Called early in main() after env is loaded.
 */
export function validateHealthAgentEnv(): void {
  const baseUrl = process.env.HEALTHAGENT_API_BASE_URL
  const apiKey = process.env.HEALTHAGENT_API_KEY
  const model = process.env.HEALTHAGENT_MODEL

  if (baseUrl) {
    const missing: string[] = []
    if (!apiKey) missing.push('HEALTHAGENT_API_KEY')
    if (!model) missing.push('HEALTHAGENT_MODEL')
    if (missing.length > 0) {
      process.stderr.write(
        `\nHealthAgent configuration error:\n` +
        `HEALTHAGENT_API_BASE_URL is set but the following are missing: ${missing.join(', ')}\n` +
        `Add them to ~/.healthagent/.env or your local .env\n\n`
      )
      process.exit(1)
    }
    return
  }

  const hasKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY

  if (hasKey) return

  process.stderr.write(`
No model API key configured. Set one of the following in ~/.healthagent/.env or your shell:

  ANTHROPIC_API_KEY                         — Anthropic Claude
  OPENAI_API_KEY                            — OpenAI
  GEMINI_API_KEY / GOOGLE_API_KEY          — Google Gemini
  HEALTHAGENT_API_BASE_URL                  — Azure OpenAI / local model (MLX, Ollama, vLLM)
    + HEALTHAGENT_API_KEY
    + HEALTHAGENT_MODEL

`)
  process.exit(1)
}
