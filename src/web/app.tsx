import { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMessage } from './components/ChatMessage.js'
import type { ChatMsg, StoredSession, ControlRequest, MetaResponse } from './types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

let _seq = 0
function uid() { return `${Date.now()}-${++_seq}` }

const STORAGE_KEY = 'verity_sessions'

function loadSessions(): StoredSession[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

function persistSessions(sessions: StoredSession[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}

function groupByDate(sessions: StoredSession[]) {
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOf(now)
  const yesterday = today - 86400000
  const lastWeek = today - 7 * 86400000

  const groups: { label: string; items: StoredSession[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Last 7 days', items: [] },
    { label: 'Older', items: [] },
  ]
  for (const s of sessions) {
    const t = new Date(s.updatedAt).getTime()
    if (t >= today) groups[0].items.push(s)
    else if (t >= yesterday) groups[1].items.push(s)
    else if (t >= lastWeek) groups[2].items.push(s)
    else groups[3].items.push(s)
  }
  return groups.filter(g => g.items.length > 0)
}

// ── Quick action definitions ──────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: 'Search Literature',  cmd: '/litReview',       icon: '🔬', desc: 'Search PubMed for evidence' },
  { label: 'Clinical Trials',    cmd: '/trialMatch',      icon: '🧪', desc: 'Find matching trials' },
  { label: 'Drug Information',   cmd: '/drugInfo',        icon: '💊', desc: 'Interactions & safety' },
  { label: 'Patient Summary',    cmd: '/patientSummary',  icon: '📋', desc: 'Summarize patient records' },
  { label: 'Clinical Coding',    cmd: '/clinicalCoding',  icon: '🏥', desc: 'ICD-10, LOINC, RxNorm' },
  { label: 'MIMIC Analytics',    cmd: '/mimicAnalytics',  icon: '📊', desc: 'Query clinical data' },
]

// ── Permission Modal ──────────────────────────────────────────────────────────

function PermissionModal({ req, onDecide }: {
  req: ControlRequest
  onDecide: (d: 'allow' | 'allow_always' | 'deny') => void
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px',
        padding: '28px', maxWidth: '460px', width: '90%',
        boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            background: '#fff7ed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2em',
          }}>⚠️</div>
          <h3 style={{ fontSize: '1em', fontWeight: 600 }}>Permission Required</h3>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.88em', marginBottom: '16px', lineHeight: 1.6 }}>
          {req.message}
        </p>
        <div style={{
          background: 'var(--surface2)', borderRadius: 'var(--radius-sm)',
          padding: '12px', marginBottom: '20px', border: '1px solid var(--border-light)',
        }}>
          <div style={{ fontWeight: 600, fontSize: '0.88em', color: 'var(--accent)', marginBottom: '4px' }}>{req.toolName}</div>
          {req.toolDescription && (
            <div style={{ fontSize: '0.82em', color: 'var(--text-dim)', marginBottom: '8px' }}>{req.toolDescription}</div>
          )}
          {Object.keys(req.input).length > 0 && (
            <pre style={{ fontSize: '0.78em', color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: '120px', overflowY: 'auto' }}>
              {JSON.stringify(req.input, null, 2)}
            </pre>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={() => onDecide('deny')}>Deny</Btn>
          <Btn variant="secondary" onClick={() => onDecide('allow')}>Allow Once</Btn>
          <Btn variant="primary" onClick={() => onDecide('allow_always')}>Always Allow</Btn>
        </div>
      </div>
    </div>
  )
}

// ── Settings Modal ────────────────────────────────────────────────────────────

function SettingsModal({ meta, onClose }: { meta: MetaResponse | null; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      backdropFilter: 'blur(2px)',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px',
        padding: '0', maxWidth: '520px', width: '90%',
        boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)',
        maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ fontSize: '1em', fontWeight: 600 }}>Settings</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--text-dim)',
            width: '28px', height: '28px', borderRadius: '6px', fontSize: '1.1em',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '20px 24px' }}>
          <Section title="MCP Servers">
            {meta?.mcpServers.length ? meta.mcpServers.map(s => (
              <div key={s.name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 0', borderBottom: '1px solid var(--border-light)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{
                    width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                    background: s.status === 'connected' ? 'var(--success)' : s.status === 'error' ? 'var(--danger)' : 'var(--text-xdim)',
                  }} />
                  <span style={{ fontWeight: 500 }}>{s.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: '20px', fontSize: '0.78em',
                    background: s.status === 'connected' ? '#dcfce7' : s.status === 'error' ? '#fee2e2' : 'var(--surface2)',
                    color: s.status === 'connected' ? 'var(--success)' : s.status === 'error' ? 'var(--danger)' : 'var(--text-dim)',
                    fontWeight: 500,
                  }}>
                    {s.status}
                  </span>
                  <span style={{ fontSize: '0.82em', color: 'var(--text-xdim)' }}>{s.tools.length} tools</span>
                </div>
              </div>
            )) : <Empty>No MCP servers configured</Empty>}
          </Section>

          <Section title="Available Skills">
            {meta?.commands.filter(c => c.isSkill).length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '4px' }}>
                {meta!.commands.filter(c => c.isSkill).map(c => (
                  <span key={c.name} title={c.description} style={{
                    padding: '4px 10px', borderRadius: '20px',
                    background: 'var(--accent-light)', color: 'var(--accent)',
                    fontSize: '0.82em', fontWeight: 500,
                  }}>
                    /{c.name}
                  </span>
                ))}
              </div>
            ) : <Empty>No skills loaded</Empty>}
          </Section>

          <Section title="Built-in Commands">
            {meta?.commands.filter(c => !c.isSkill).length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '4px' }}>
                {meta!.commands.filter(c => !c.isSkill).map(c => (
                  <span key={c.name} title={c.description} style={{
                    padding: '4px 10px', borderRadius: '20px',
                    background: 'var(--surface2)', color: 'var(--text-dim)',
                    fontSize: '0.82em',
                  }}>
                    /{c.name}
                  </span>
                ))}
              </div>
            ) : <Empty>No commands loaded</Empty>}
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ fontSize: '0.75em', fontWeight: 600, color: 'var(--text-xdim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '10px' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.88em', color: 'var(--text-xdim)', fontStyle: 'italic' }}>{children}</div>
}

// ── Command Palette ───────────────────────────────────────────────────────────

function CommandPalette({ meta, query, onPick, onClose }: {
  meta: MetaResponse | null
  query: string
  onPick: (cmd: string) => void
  onClose: () => void
}) {
  const q = query.slice(1).toLowerCase()
  const matches = (meta?.commands ?? []).filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 150,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      paddingBottom: '80px',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px',
        width: '520px', maxWidth: '90vw',
        boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)',
        overflow: 'hidden', maxHeight: '360px', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
          fontSize: '0.82em', color: 'var(--text-xdim)', fontWeight: 500,
        }}>
          Commands & Skills
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {matches.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-xdim)', fontSize: '0.88em' }}>
              No commands match "{q}"
            </div>
          )}
          {matches.map(c => (
            <button key={c.name} onClick={() => onPick(`/${c.name}`)} style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              width: '100%', padding: '10px 14px',
              background: 'none', border: 'none', textAlign: 'left',
              borderBottom: '1px solid var(--border-light)',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <span style={{
                width: '28px', height: '28px', borderRadius: '8px', flexShrink: 0,
                background: c.isSkill ? 'var(--accent-light)' : 'var(--surface2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.75em', fontWeight: 700,
                color: c.isSkill ? 'var(--accent)' : 'var(--text-dim)',
              }}>
                {c.isSkill ? '✦' : '/'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: '0.9em' }}>/{c.name}</div>
                {c.description && (
                  <div style={{ fontSize: '0.8em', color: 'var(--text-dim)', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.description}
                  </div>
                )}
              </div>
              {c.isSkill && (
                <span style={{ fontSize: '0.75em', color: 'var(--accent)', fontWeight: 500, flexShrink: 0 }}>Skill</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ sessions, currentId, onSelect, onNew, onDelete }: {
  sessions: StoredSession[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const groups = groupByDate(sessions)
  const [hoverId, setHoverId] = useState<string | null>(null)

  return (
    <div style={{
      width: 'var(--sidebar-w)', background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      height: '100%', flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{
        height: 'var(--topbar-h)', display: 'flex', alignItems: 'center',
        padding: '0 16px', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          width: '26px', height: '26px', borderRadius: '8px',
          background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.65em', fontWeight: 800, color: '#fff', marginRight: '8px',
          letterSpacing: '-0.02em',
        }}>VA</div>
        <span style={{ fontWeight: 700, fontSize: '0.95em', color: 'var(--text)' }}>Verity</span>
      </div>

      {/* New Chat */}
      <div style={{ padding: '12px 10px 8px' }}>
        <button onClick={onNew} style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          width: '100%', padding: '8px 12px',
          background: 'var(--accent)', color: '#fff',
          border: 'none', borderRadius: 'var(--radius-sm)',
          fontWeight: 500, fontSize: '0.88em',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <span style={{ fontSize: '1.1em', lineHeight: 1 }}>+</span>
          New Chat
        </button>
      </div>

      {/* History */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 12px' }}>
        {groups.length === 0 && (
          <div style={{ padding: '20px 16px', color: 'var(--text-xdim)', fontSize: '0.85em', textAlign: 'center' }}>
            No history yet
          </div>
        )}
        {groups.map(g => (
          <div key={g.label}>
            <div style={{
              padding: '10px 16px 4px',
              fontSize: '0.72em', fontWeight: 600, color: 'var(--text-xdim)',
              textTransform: 'uppercase', letterSpacing: '0.07em',
            }}>
              {g.label}
            </div>
            {g.items.map(s => (
              <div
                key={s.id}
                onMouseEnter={() => setHoverId(s.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{
                  position: 'relative',
                  background: s.id === currentId ? 'var(--accent-light)' : hoverId === s.id ? 'var(--surface2)' : 'transparent',
                  borderLeft: s.id === currentId ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                <button onClick={() => onSelect(s.id)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 36px 8px 14px',
                  background: 'none', border: 'none',
                  color: s.id === currentId ? 'var(--accent)' : 'var(--text)',
                  fontSize: '0.85em',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.title}
                </button>
                {hoverId === s.id && (
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(s.id) }}
                    style={{
                      position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', color: 'var(--text-xdim)',
                      width: '20px', height: '20px', borderRadius: '4px',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.9em',
                    }}
                  >✕</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Welcome Screen ────────────────────────────────────────────────────────────

function WelcomeScreen({ meta, onAction }: {
  meta: MetaResponse | null
  onAction: (cmd: string) => void
}) {
  const availableSkills = new Set(meta?.commands.map(c => c.name) ?? [])
  const actions = QUICK_ACTIONS.filter(a => availableSkills.has(a.cmd.slice(1)))

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '40px 24px',
    }}>
      <div style={{
        width: '52px', height: '52px', borderRadius: '16px',
        background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1em', fontWeight: 800, color: '#fff', marginBottom: '16px',
        boxShadow: '0 4px 14px rgba(37,99,235,0.35)',
        letterSpacing: '-0.02em',
      }}>VA</div>
      <h1 style={{ fontSize: '1.35em', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
        Verity Health Agent
      </h1>
      <p style={{ color: 'var(--text-dim)', fontSize: '0.92em', marginBottom: '32px', textAlign: 'center', maxWidth: '360px', lineHeight: 1.6 }}>
        AI-powered clinical research assistant. Ask anything or choose a quick action below.
      </p>

      {actions.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '10px', width: '100%', maxWidth: '640px',
        }}>
          {actions.map(a => (
            <button key={a.cmd} onClick={() => onAction(a.cmd)} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '14px 16px',
              textAlign: 'left', boxShadow: 'var(--shadow-sm)',
              transition: 'box-shadow 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.boxShadow = 'var(--shadow-md)'
              e.currentTarget.style.borderColor = '#c7d2fe'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.boxShadow = 'var(--shadow-sm)'
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
            >
              <div style={{ fontSize: '1.3em', marginBottom: '6px' }}>{a.icon}</div>
              <div style={{ fontWeight: 600, fontSize: '0.9em', marginBottom: '2px' }}>{a.label}</div>
              <div style={{ fontSize: '0.8em', color: 'var(--text-dim)' }}>{a.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Small button component ────────────────────────────────────────────────────

function Btn({ variant = 'primary', onClick, children, disabled }: {
  variant?: 'primary' | 'secondary' | 'ghost'
  onClick?: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  const styles: Record<string, React.CSSProperties> = {
    primary:   { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' },
    secondary: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' },
    ghost:     { background: 'none', color: 'var(--danger)', border: '1px solid transparent' },
  }
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...styles[variant], borderRadius: '8px', padding: '7px 16px',
      fontWeight: 500, fontSize: '0.88em', opacity: disabled ? 0.5 : 1,
    }}>
      {children}
    </button>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  const [sessions, setSessions] = useState<StoredSession[]>(() => loadSessions())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingControl, setPendingControl] = useState<ControlRequest | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const pendingControlRef = useRef<{ resolve: (d: string) => void } | null>(null)
  const sessionsRef = useRef(sessions)
  useEffect(() => { sessionsRef.current = sessions }, [sessions])

  const fetchMeta = useCallback(async () => {
    try {
      const r = await fetch('/api/meta')
      if (r.ok) setMeta(await r.json())
    } catch {}
  }, [])

  useEffect(() => { fetchMeta() }, [fetchMeta])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Command palette on "/"
  useEffect(() => {
    if (input.startsWith('/')) setShowPalette(true)
    else setShowPalette(false)
  }, [input])

  // ── Session helpers ─────────────────────────────────────────────────────────

  function upsertSession(session: StoredSession) {
    setSessions(prev => {
      const next = prev.some(s => s.id === session.id)
        ? prev.map(s => s.id === session.id ? session : s)
        : [session, ...prev]
      persistSessions(next)
      return next
    })
  }

  function startNewChat() {
    setCurrentId(null)
    setMessages([])
    setInput('')
    inputRef.current?.focus()
  }

  function loadSession(id: string) {
    const s = sessionsRef.current.find(x => x.id === id)
    if (!s) return
    setCurrentId(id)
    setMessages(s.messages)
    setInput('')
  }

  function deleteSession(id: string) {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      persistSessions(next)
      return next
    })
    if (currentId === id) startNewChat()
  }

  // ── Message state helpers ───────────────────────────────────────────────────

  function patchLastAssistant(updater: (prev: ChatMsg) => Partial<ChatMsg>, sessionId: string, sessionTitle: string) {
    setMessages(prev => {
      const copy = [...prev]
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant') {
          copy[i] = { ...copy[i], ...updater(copy[i]) }
          break
        }
      }
      upsertSession({
        id: sessionId,
        title: sessionTitle,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: copy,
      })
      return copy
    })
  }

  // ── SSE consumer ────────────────────────────────────────────────────────────

  async function openStream(sid: string, sessionTitle: string, initialMsgs: ChatMsg[]) {
    esRef.current?.close()
    const es = new EventSource(`/api/stream/${sid}`)
    esRef.current = es

    let currentMsgs = [...initialMsgs]
    const assistantMsg: ChatMsg = { id: uid(), role: 'assistant', content: '', streaming: true }
    currentMsgs = [...currentMsgs, assistantMsg]
    setMessages(currentMsgs)
    upsertSession({ id: sid, title: sessionTitle, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: currentMsgs })

    es.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          patchLastAssistant(prev => ({ content: (prev.content ?? '') + ev.delta.text, streaming: true }), sid, sessionTitle)
        }
        return
      }

      if (msg.type === 'assistant') {
        const text = (msg.message?.content ?? [])
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text).join('')
        if (text) patchLastAssistant(() => ({ content: text, streaming: false }), sid, sessionTitle)
        return
      }

      if (msg.type === 'tool_use') {
        const toolMsg: ChatMsg = {
          id: uid(), role: 'tool',
          toolName: msg.name ?? msg.tool_name ?? 'tool',
          input: msg.input, content: '',
        }
        setMessages(prev => {
          const next = [...prev, toolMsg]
          upsertSession({ id: sid, title: sessionTitle, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: next })
          return next
        })
        return
      }

      if (msg.type === 'tool_result') {
        const raw = msg.content
        const text = Array.isArray(raw)
          ? raw.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n')
          : typeof raw === 'string' ? raw : ''
        setMessages(prev => {
          const copy = [...prev]
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'tool' && !copy[i].content) {
              copy[i] = { ...copy[i], content: text }
              break
            }
          }
          upsertSession({ id: sid, title: sessionTitle, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: copy })
          return copy
        })
        return
      }

      if (msg.type === 'result') {
        patchLastAssistant(() => ({ streaming: false }), sid, sessionTitle)
        setIsStreaming(false)
        es.close(); esRef.current = null
        fetchMeta()
      }
    })

    es.addEventListener('control_request', (e: MessageEvent) => {
      const req = JSON.parse(e.data) as ControlRequest
      pendingControlRef.current = {
        resolve: async (decision: string) => {
          setPendingControl(null)
          pendingControlRef.current = null
          await fetch(`/api/control/${sid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: req.requestId, decision }),
          })
        },
      }
      setPendingControl(req)
    })

    es.addEventListener('error', () => {
      patchLastAssistant(() => ({ streaming: false }), sid, sessionTitle)
      setIsStreaming(false)
      es.close(); esRef.current = null
    })
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    setInput('')
    setShowPalette(false)
    setIsStreaming(true)

    const title = trimmed.slice(0, 52) + (trimmed.length > 52 ? '…' : '')
    const userMsg: ChatMsg = { id: uid(), role: 'user', content: trimmed }
    const nextMsgs = [...messages, userMsg]
    // Optimistic UI update only — no localStorage until we have the real backendSid
    setMessages(nextMsgs)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, sessionId: currentId ?? undefined }),
      })
      const { sessionId: backendSid } = await res.json()
      // Set current ID from server (single source of truth)
      setCurrentId(backendSid)
      await openStream(backendSid, title, nextMsgs)
    } catch (err) {
      setMessages(prev => [...prev, { id: uid(), role: 'assistant', content: `Error: ${String(err)}` }])
      setIsStreaming(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') { setShowPalette(false); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function pickCommand(cmd: string) {
    setInput(cmd + ' ')
    setShowPalette(false)
    inputRef.current?.focus()
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>

      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={id => { loadSession(id) }}
        onNew={startNewChat}
        onDelete={deleteSession}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        {/* Top bar */}
        <div style={{
          height: 'var(--topbar-h)', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 20px',
          background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.95em' }}>
              {currentId
                ? sessions.find(s => s.id === currentId)?.title ?? 'Chat'
                : 'New Chat'}
            </span>
          </div>
          <button onClick={() => setShowSettings(true)} title="Settings" style={{
            background: 'none', border: '1px solid var(--border)',
            borderRadius: '8px', width: '32px', height: '32px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-dim)', fontSize: '0.9em',
          }}>
            ⚙
          </button>
        </div>

        {/* Messages or Welcome */}
        {messages.length === 0
          ? <WelcomeScreen meta={meta} onAction={cmd => { setInput(cmd + ' '); inputRef.current?.focus() }} />
          : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
              {messages.map(msg => (
                <ChatMessage key={msg.id} msg={msg} isStreaming={isStreaming} />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )
        }

        {/* Quick action chips — shown only when messages exist */}
        {messages.length > 0 && !isStreaming && meta && (
          <div style={{
            display: 'flex', gap: '6px', flexWrap: 'wrap',
            padding: '8px 32px 0',
          }}>
            {QUICK_ACTIONS
              .filter(a => meta.commands.some(c => c.name === a.cmd.slice(1)))
              .map(a => (
                <button key={a.cmd} onClick={() => pickCommand(a.cmd)} style={{
                  padding: '4px 12px', borderRadius: '20px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  fontSize: '0.8em', color: 'var(--text-dim)',
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  {a.icon} {a.label}
                </button>
              ))
            }
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: '12px 32px 20px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', gap: '10px', alignItems: 'flex-end',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: '14px', padding: '10px 10px 10px 16px',
            boxShadow: 'var(--shadow)',
            transition: 'border-color 0.15s',
          }}
          onFocusCapture={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Waiting for response…' : 'Ask Verity anything… (/ for commands)'}
              disabled={isStreaming}
              rows={1}
              style={{
                flex: 1, resize: 'none', background: 'none', border: 'none',
                color: 'var(--text)', fontSize: '0.95em', lineHeight: 1.55,
                maxHeight: '160px', overflowY: 'auto',
                opacity: isStreaming ? 0.6 : 1,
              }}
              onInput={e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isStreaming}
              style={{
                width: '34px', height: '34px', borderRadius: '10px', flexShrink: 0,
                background: (!input.trim() || isStreaming) ? 'var(--surface2)' : 'var(--accent)',
                color: (!input.trim() || isStreaming) ? 'var(--text-xdim)' : '#fff',
                border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
          <div style={{ textAlign: 'center', marginTop: '6px', fontSize: '0.72em', color: 'var(--text-xdim)' }}>
            Verity may make mistakes. Always verify clinical information with authoritative sources.
          </div>
        </div>
      </div>

      {showPalette && (
        <CommandPalette meta={meta} query={input} onPick={pickCommand} onClose={() => setShowPalette(false)} />
      )}
      {showSettings && <SettingsModal meta={meta} onClose={() => setShowSettings(false)} />}
      {pendingControl && (
        <PermissionModal req={pendingControl} onDecide={d => pendingControlRef.current?.resolve(d)} />
      )}
    </div>
  )
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')!).render(<App />)
