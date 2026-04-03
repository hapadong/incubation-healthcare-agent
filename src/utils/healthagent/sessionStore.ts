/**
 * HealthAgent Session Store
 *
 * Abstraction layer over session persistence.  Today: local disk, date-bucketed.
 * Future: swap in RemoteAPISessionStore when SSO + backend DB lands, or
 * S3SessionStore for object-storage deployments.  The interface is intentionally
 * narrow so implementors only need to satisfy what the CLI actually uses.
 *
 * Switching backends: set HEALTHAGENT_SESSION_BACKEND=remote (not yet built).
 * The factory getSessionStore() reads that env var and returns the right impl.
 *
 * Session index
 * -------------
 * Because sessions are plain UUIDs (compatible with --resume), we maintain a
 * lightweight index at ~/.healthagent/sessions/index.json that maps
 * sessionId → { date, startedAt }.  This lets resume lookups find the correct
 * date-bucket in O(1) without scanning directories.  The index becomes the
 * DB table when remote storage lands.
 */

import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'fs/promises'
import { join } from 'path'
import { getHealthAgentHomeDir } from '../envUtils.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  /** Primary key — stable across devices once sessions move to DB. */
  sessionId: string
  /** YYYY-MM-DD */
  date: string
  /** ISO timestamp of session start */
  startedAt: string
  /**
   * Populated post-SSO. Undefined in local-only mode.
   * Future DB index: (userId, date) for cross-device session listing.
   */
  userId?: string
  /** Auto-generated title (first user message summary). Optional for now. */
  title?: string
}

// Shape of ~/.healthagent/sessions/index.json
type SessionIndexFile = Record<string, { date: string; startedAt: string }>

/**
 * Core session store interface.
 *
 * Implementations:
 *   LocalDiskSessionStore  — ~/.healthagent/sessions/YYYY-MM-DD/<uuid>.jsonl
 *   RemoteAPISessionStore  — POST /api/sessions/:id/events  (future)
 */
export interface HealthAgentSessionStore {
  /**
   * Register a new session in the index.  Call once at session start.
   * Idempotent — writing the same sessionId twice is a no-op.
   */
  registerSession(sessionId: string): Promise<void>

  /**
   * Look up which date-bucket a session lives in.
   * Returns undefined if the session isn't in the index (e.g. very old session
   * created before the index existed — fallback: scan all date dirs).
   */
  findSessionDate(sessionId: string): Promise<string | undefined>

  /**
   * Resolve the absolute filesystem path for a session's JSONL transcript.
   * Remote store implementations may return a local cache path.
   */
  transcriptPath(sessionId: string, date: string): string

  /**
   * List sessions, newest first.
   * In local mode, reads the index then optionally filters by date.
   * In remote mode, queries the API with userId from the SSO token.
   */
  listSessions(opts?: { date?: string; limit?: number }): Promise<SessionMeta[]>
}

// ---------------------------------------------------------------------------
// Local disk implementation
// ---------------------------------------------------------------------------

export class LocalDiskSessionStore implements HealthAgentSessionStore {
  private sessionsRoot(): string {
    return join(getHealthAgentHomeDir(), 'sessions')
  }

  private indexPath(): string {
    return join(this.sessionsRoot(), 'index.json')
  }

  private async readIndex(): Promise<SessionIndexFile> {
    try {
      const raw = await readFile(this.indexPath(), 'utf8')
      return JSON.parse(raw) as SessionIndexFile
    } catch {
      return {}
    }
  }

  private async writeIndex(index: SessionIndexFile): Promise<void> {
    await mkdir(this.sessionsRoot(), { recursive: true, mode: 0o700 })
    await writeFile(this.indexPath(), JSON.stringify(index, null, 2), 'utf8')
  }

  async registerSession(sessionId: string): Promise<void> {
    const index = await this.readIndex()
    if (index[sessionId]) return // already registered, idempotent
    const now = new Date()
    index[sessionId] = {
      date: now.toISOString().slice(0, 10),
      startedAt: now.toISOString(),
    }
    await this.writeIndex(index)
  }

  async findSessionDate(sessionId: string): Promise<string | undefined> {
    const index = await this.readIndex()
    return index[sessionId]?.date
  }

  transcriptPath(sessionId: string, date: string): string {
    return join(this.sessionsRoot(), date, `${sessionId}.jsonl`)
  }

  async listSessions(
    opts: { date?: string; limit?: number } = {},
  ): Promise<SessionMeta[]> {
    const index = await this.readIndex()

    // Build list from index, sorted newest first by startedAt
    let entries = Object.entries(index).map(([sessionId, meta]) => ({
      sessionId,
      date: meta.date,
      startedAt: meta.startedAt,
    }))

    if (opts.date) {
      entries = entries.filter(e => e.date === opts.date)
    }

    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    if (opts.limit) {
      entries = entries.slice(0, opts.limit)
    }

    return entries
  }
}

// ---------------------------------------------------------------------------
// Future: RemoteAPISessionStore skeleton (not implemented)
// ---------------------------------------------------------------------------

// export class RemoteAPISessionStore implements HealthAgentSessionStore {
//   constructor(private baseUrl: string, private token: string) {}
//   async registerSession(sessionId) { /* POST /api/sessions */ }
//   async findSessionDate(sessionId) { /* GET /api/sessions/:id */ }
//   transcriptPath(sessionId, date) { /* local cache path */ }
//   async listSessions(...) { /* GET /api/sessions */ }
// }

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _store: HealthAgentSessionStore | null = null

/**
 * Returns the active session store.
 * Reads HEALTHAGENT_SESSION_BACKEND to select the implementation.
 * Cached after first call — call resetSessionStore() in tests.
 */
export function getSessionStore(): HealthAgentSessionStore {
  if (_store) return _store
  const backend = process.env.HEALTHAGENT_SESSION_BACKEND ?? 'local'
  if (backend === 'remote') {
    throw new Error(
      'HEALTHAGENT_SESSION_BACKEND=remote is not yet implemented. ' +
        'It will be enabled when SSO + backend DB integration lands.',
    )
  }
  _store = new LocalDiskSessionStore()
  return _store
}

/** For testing only — resets the cached store instance. */
export function resetSessionStore(): void {
  _store = null
}

// ---------------------------------------------------------------------------
// Convenience: find transcript path by sessionId alone
// Falls back to scanning date directories if sessionId isn't in the index
// (handles sessions created before the index existed).
// ---------------------------------------------------------------------------

export async function findTranscriptPath(
  sessionId: string,
): Promise<string | undefined> {
  const store = getSessionStore()
  let date = await store.findSessionDate(sessionId)

  if (!date) {
    // Index miss — scan date directories as fallback
    date = await scanForSession(sessionId)
  }

  if (!date) return undefined
  return store.transcriptPath(sessionId, date)
}

async function scanForSession(sessionId: string): Promise<string | undefined> {
  const root = join(getHealthAgentHomeDir(), 'sessions')
  let dateDirs: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    dateDirs = entries
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse() // newest first — most likely to match a recent resume
  } catch {
    return undefined
  }

  for (const date of dateDirs) {
    try {
      const files = await readdir(join(root, date))
      if (files.includes(`${sessionId}.jsonl`)) {
        return date
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return undefined
}
