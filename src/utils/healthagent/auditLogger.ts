/**
 * Local append-only audit logger for Verity Health Agent.
 *
 * Writes JSONL entries to ~/.healthagent/audit/YYYY-MM-DD.jsonl
 * Inputs are hashed (sha256) — raw content is never stored.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

export type AuditEntry = {
  timestamp: string
  session_id: string
  user: string
  tool: string
  external: boolean
  input_hash: string
  phi_blocked: boolean
  phi_categories?: string[]
  outcome: 'success' | 'blocked' | 'error'
}

function getAuditDir(): string {
  return join(homedir(), '.healthagent', 'audit')
}

function getAuditPath(): string {
  const date = new Date().toISOString().split('T')[0]!
  return join(getAuditDir(), `${date}.jsonl`)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

let _auditDirEnsured = false
function ensureAuditDir(): void {
  if (_auditDirEnsured) return
  mkdirSync(getAuditDir(), { recursive: true })
  _auditDirEnsured = true
}

export function logAuditEntry(entry: AuditEntry): void {
  try {
    ensureAuditDir()
    appendFileSync(getAuditPath(), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Audit logging must never crash the agent
  }
}

export function buildAuditEntry(params: {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  external: boolean
  phiBlocked: boolean
  phiCategories?: string[]
  outcome: AuditEntry['outcome']
}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    session_id: params.sessionId,
    user: process.env.USER ?? process.env.USERNAME ?? 'unknown',
    tool: params.toolName,
    external: params.external,
    input_hash: sha256(JSON.stringify(params.toolInput)),
    phi_blocked: params.phiBlocked,
    ...(params.phiCategories?.length ? { phi_categories: params.phiCategories } : {}),
    outcome: params.outcome,
  }
}
