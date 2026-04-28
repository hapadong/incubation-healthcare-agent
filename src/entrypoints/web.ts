import { config as loadDotenv } from 'dotenv'
loadDotenv()

// Tell all isHealthAgent checks that this process is the HealthAgent web server.
// Without this, process.argv[1] is 'web.cjs' (not 'ha') so identity falls back to generic Claude.
process.env.HEALTHAGENT_WEB = '1'

import { randomUUID } from 'crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { ask } from '../QueryEngine.js'
import {
  createEngineSession,
  createWebCanUseTool,
  getMcpServerMeta,
  type EngineSession,
  type WebPermissionDecision,
  type WebPermissionRequest,
} from '../shared/engineFactory.js'
import type { Command } from '../commands.js'
import type { Message } from '../types/message.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from '../utils/fileStateCache.js'
import { getCwd } from '../utils/cwd.js'
import { enableConfigs } from '../utils/config.js'
import { applySafeConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { setOriginalCwd, switchSession } from '../bootstrap/state.js'
import type { SessionId } from '../bootstrap/state.js'

// ── Types ────────────────────────────────────────────────────────────────────

type PendingControl = {
  resolve: (decision: WebPermissionDecision) => void
  req: WebPermissionRequest
}

type WebSession = {
  messages: Message[]
  fileCache: FileStateCache
  pendingControls: Map<string, PendingControl>
  pendingMessage: string | null
  abortController: AbortController
  lastActiveAt: Date
}

// ── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map<string, WebSession>()

const SESSION_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const KEEPALIVE_INTERVAL_MS = 15_000       // 15s while waiting for permission

function createSession(): WebSession {
  return {
    messages: [],
    fileCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    pendingControls: new Map(),
    pendingMessage: null,
    abortController: new AbortController(),
    lastActiveAt: new Date(),
  }
}

function expireSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessions) {
    if (session.lastActiveAt.getTime() < cutoff) {
      session.abortController.abort()
      sessions.delete(id)
    }
  }
}

// Clean up expired sessions every 30 minutes
setInterval(expireSessions, 30 * 60 * 1000).unref()

// ── Build app ─────────────────────────────────────────────────────────────────

function buildApp(engineSession: EngineSession) {
  const app = new Hono()

  app.use('*', cors({ origin: '*' }))

  // ── POST /api/chat ──────────────────────────────────────────────────────────
  // Accepts a message, creates or continues a session, returns sessionId.
  // Client then opens GET /api/stream/:sessionId to receive the response.
  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message: string; sessionId?: string }>()
    const { message, sessionId: existingId } = body

    if (!message?.trim()) {
      return c.json({ error: 'message is required' }, 400)
    }

    const sessionId =
      existingId && sessions.has(existingId) ? existingId : randomUUID()

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, createSession())
    }

    const session = sessions.get(sessionId)!
    session.pendingMessage = message
    session.lastActiveAt = new Date()

    return c.json({ sessionId })
  })

  // ── GET /api/stream/:sessionId ──────────────────────────────────────────────
  // SSE stream: pumps SDKMessage frames until the turn completes.
  // Pauses when a permission prompt is needed and resumes after /api/control.
  app.get('/api/stream/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const session = sessions.get(sessionId)

    if (!session) {
      return c.json({ error: 'Session not found or expired' }, 404)
    }
    if (!session.pendingMessage) {
      return c.json({ error: 'No message pending for this session' }, 400)
    }

    const message = session.pendingMessage
    session.pendingMessage = null
    session.lastActiveAt = new Date()

    // Set global session ID so audit log entries are tagged with this web session.
    // Best-effort: concurrent sessions share the global; the last to start wins.
    switchSession(sessionId as SessionId)

    return streamSSE(c, async (stream) => {
      // Permission handler: emits a control_request event then waits for
      // POST /api/control/:sessionId to resolve it before continuing
      const requestPermission = async (
        req: WebPermissionRequest,
      ): Promise<WebPermissionDecision> => {
        const requestId = randomUUID()

        await stream.writeSSE({
          event: 'control_request',
          data: JSON.stringify({ requestId, ...req }),
        })

        // Keep the SSE connection alive while waiting for user decision
        const keepAlive = setInterval(async () => {
          await stream.writeSSE({ event: 'keep_alive', data: '{}' })
        }, KEEPALIVE_INTERVAL_MS)

        return new Promise<WebPermissionDecision>((resolve) => {
          session.pendingControls.set(requestId, { resolve, req })
        }).finally(() => {
          clearInterval(keepAlive)
          session.pendingControls.delete(requestId)
        })
      }

      // When user picks "Always Allow", add tool to session alwaysAllowRules
      const onAllowAlways = (toolName: string): void => {
        engineSession.setAppState((prev) => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            alwaysAllowRules: {
              ...prev.toolPermissionContext.alwaysAllowRules,
              session: [
                ...(prev.toolPermissionContext.alwaysAllowRules.session ?? []),
                toolName,
              ],
            },
          },
        }))
      }

      const canUseTool = createWebCanUseTool(requestPermission, onAllowAlways)

      let fileCache = session.fileCache

      try {
        const generator = ask({
          prompt: message,
          cwd: getCwd(),
          tools: engineSession.tools,
          commands: engineSession.commands,
          mcpClients: engineSession.mcpClients,
          agents: engineSession.agents,
          canUseTool,
          mutableMessages: session.messages,
          getAppState: engineSession.getAppState,
          setAppState: engineSession.setAppState,
          getReadFileCache: () => fileCache,
          setReadFileCache: (cache) => {
            fileCache = cache
            session.fileCache = cache
          },
          abortController: session.abortController,
        })

        for await (const msg of generator) {
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify(msg),
          })
          // SDKResultMessage signals the turn is complete
          if (msg.type === 'result') break
        }
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
          }),
        })
      }
    })
  })

  // ── POST /api/control/:sessionId ────────────────────────────────────────────
  // Browser replies to a permission prompt (approve / always approve / deny).
  app.post('/api/control/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const session = sessions.get(sessionId)

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const body = await c.req.json<{
      requestId: string
      decision: WebPermissionDecision
    }>()

    const pending = session.pendingControls.get(body.requestId)
    if (!pending) {
      return c.json({ error: 'No pending control request with that id' }, 404)
    }

    pending.resolve(body.decision)
    return c.json({ ok: true })
  })

  // ── GET /api/meta ───────────────────────────────────────────────────────────
  // Returns available commands (skills) and MCP server status for the sidebar
  // and slash-command autocomplete.
  app.get('/api/meta', (c) => {
    const commands = engineSession.commands.map((cmd: Command) => ({
      name: 'name' in cmd ? cmd.name : '',
      description: 'description' in cmd ? cmd.description : '',
      isSkill: 'type' in cmd && cmd.type === 'prompt',
    }))

    const mcpServers = getMcpServerMeta(engineSession)

    const mcpTools = engineSession.tools
      .filter((t) => t.name.startsWith('mcp__'))
      .map((t) => ({
        name: t.name,
        server: t.name.split('__')[1] ?? '',
        description: (t as { description?: string }).description ?? '',
      }))

    return c.json({ commands, mcpServers, mcpTools })
  })

  // ── Static frontend ─────────────────────────────────────────────────────────
  app.use(
    '/*',
    serveStatic({ root: './dist/web-static' }),
  )

  return app
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const port = Number(process.env.HEALTHAGENT_WEB_PORT ?? 3000)
  const cwd = getCwd()

  // Must run before any config reads (mirrors init.ts in the CLI path)
  setOriginalCwd(cwd)
  enableConfigs()
  applySafeConfigEnvironmentVariables()

  console.log('Starting HealthAgent web server...')
  console.log(`Initializing tools and MCP servers from ${cwd}`)

  // Register PHI guardrail + audit logger (same hooks as CLI path)
  await import('../utils/healthagent/complianceHooks.js')
    .then(m => m.registerComplianceHooks())
    .catch(err => console.error('[HealthAgent] Failed to load compliance hooks:', err))

  const engineSession = await createEngineSession({ cwd })
  const mcpMeta = getMcpServerMeta(engineSession)

  console.log(
    `MCP servers: ${mcpMeta.map((s) => `${s.name}(${s.status})`).join(', ')}`,
  )
  console.log(`Tools loaded: ${engineSession.tools.length}`)
  console.log(`Commands loaded: ${engineSession.commands.length}`)

  const app = buildApp(engineSession)

  serve({ fetch: app.fetch, port }, () => {
    console.log(`HealthAgent web UI: http://localhost:${port}`)
  })
}

main().catch((err) => {
  console.error('Fatal error starting web server:', err)
  process.exit(1)
})
