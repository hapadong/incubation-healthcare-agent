import { useState, useEffect, useRef, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMessage } from './components/ChatMessage.js'
import type { ChatMsg, ControlRequest, MetaResponse } from './types.js'

// ── Unique ID ─────────────────────────────────────────────────────────────────

let _seq = 0
function uid() { return `${Date.now()}-${++_seq}` }

// ── Permission Modal ──────────────────────────────────────────────────────────

function PermissionModal({
  req,
  onDecide,
}: {
  req: ControlRequest
  onDecide: (decision: 'allow' | 'allow_always' | 'deny') => void
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '24px', maxWidth: '480px',
          width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <h3 style={{ marginBottom: '8px', fontSize: '1em', fontWeight: 600 }}>
          Permission Required
        </h3>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.88em', marginBottom: '16px' }}>
          {req.message}
        </p>

        <div
          style={{
            background: 'var(--tool-bg)', border: '1px solid var(--border)',
            borderRadius: '6px', padding: '12px', marginBottom: '18px',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '0.9em', color: 'var(--accent)', marginBottom: '6px' }}>
            {req.toolName}
          </div>
          {req.toolDescription && (
            <div style={{ fontSize: '0.82em', color: 'var(--text-dim)', marginBottom: '8px' }}>
              {req.toolDescription}
            </div>
          )}
          {Object.keys(req.input).length > 0 && (
            <pre style={{ fontSize: '0.78em', color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
              {JSON.stringify(req.input, null, 2)}
            </pre>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={() => onDecide('deny')} style={btnStyle('var(--danger)')}>
            Deny
          </button>
          <button onClick={() => onDecide('allow')} style={btnStyle('var(--surface2)')}>
            Allow Once
          </button>
          <button onClick={() => onDecide('allow_always')} style={btnStyle('var(--accent)')}>
            Always Allow
          </button>
        </div>
      </div>
    </div>
  )
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg, color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: '6px', padding: '8px 16px', cursor: 'pointer',
    fontSize: '0.88em', fontWeight: 500,
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ meta, onCommand }: { meta: MetaResponse | null; onCommand: (cmd: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  function toggle(k: string) {
    setExpanded(prev => ({ ...prev, [k]: !prev[k] }))
  }

  return (
    <div
      style={{
        width: 'var(--sidebar-w)', background: 'var(--surface)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
      }}
    >
      <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 700, fontSize: '1.05em', color: 'var(--accent)' }}>HealthAgent</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
        {/* MCP Servers */}
        <SideSection label="MCP Servers" open={expanded['mcp']} onToggle={() => toggle('mcp')}>
          {meta?.mcpServers.map(s => (
            <div key={s.name} style={{ padding: '4px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
                background: s.status === 'connected' ? 'var(--success)' : s.status === 'error' ? 'var(--danger)' : 'var(--text-dim)',
              }} />
              <span style={{ fontSize: '0.85em', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: '0.75em', color: 'var(--text-dim)' }}>
                {s.tools.length}
              </span>
            </div>
          ))}
          {!meta?.mcpServers.length && <EmptyRow />}
        </SideSection>

        {/* Skills */}
        <SideSection label="Skills" open={expanded['skills']} onToggle={() => toggle('skills')}>
          {meta?.commands.filter(c => c.isSkill).map(c => (
            <button
              key={c.name}
              onClick={() => onCommand(`/${c.name}`)}
              title={c.description}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '5px 14px', background: 'none', border: 'none',
                color: 'var(--text)', cursor: 'pointer', fontSize: '0.85em',
              }}
            >
              <span style={{ color: 'var(--accent)' }}>/</span>{c.name}
            </button>
          ))}
          {!meta?.commands.filter(c => c.isSkill).length && <EmptyRow />}
        </SideSection>

        {/* Built-in commands */}
        <SideSection label="Commands" open={expanded['cmds']} onToggle={() => toggle('cmds')}>
          {meta?.commands.filter(c => !c.isSkill).map(c => (
            <div key={c.name} title={c.description} style={{ padding: '4px 14px', fontSize: '0.85em', color: 'var(--text-dim)' }}>
              {c.name}
            </div>
          ))}
          {!meta?.commands.filter(c => !c.isSkill).length && <EmptyRow />}
        </SideSection>
      </div>
    </div>
  )
}

function SideSection({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: '4px' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', width: '100%', gap: '6px',
          padding: '6px 14px', background: 'none', border: 'none',
          color: 'var(--text-dim)', cursor: 'pointer', fontSize: '0.78em',
          fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}
      >
        <span style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
        {label}
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function EmptyRow() {
  return <div style={{ padding: '4px 14px', fontSize: '0.82em', color: 'var(--text-dim)', fontStyle: 'italic' }}>none</div>
}

// ── Main App ──────────────────────────────────────────────────────────────────

function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingControl, setPendingControl] = useState<ControlRequest | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggIdx, setSuggIdx] = useState(-1)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const pendingControlRef = useRef<{ requestId: string; resolve: (d: string) => void } | null>(null)

  // Fetch meta on mount (and after each turn to pick up dynamic changes)
  const fetchMeta = useCallback(async () => {
    try {
      const r = await fetch('/api/meta')
      if (r.ok) setMeta(await r.json())
    } catch {}
  }, [])

  useEffect(() => { fetchMeta() }, [fetchMeta])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Slash-command autocomplete
  useEffect(() => {
    if (!input.startsWith('/') || !meta) { setSuggestions([]); return }
    const q = input.slice(1).toLowerCase()
    const matches = meta.commands
      .filter(c => c.name.toLowerCase().startsWith(q))
      .map(c => `/${c.name}`)
    setSuggestions(matches)
    setSuggIdx(-1)
  }, [input, meta])

  function appendMsg(msg: ChatMsg) {
    setMessages(prev => [...prev, msg])
  }

  function patchLastAssistant(patch: Partial<ChatMsg> | ((prev: ChatMsg) => Partial<ChatMsg>)) {
    setMessages(prev => {
      const copy = [...prev]
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'assistant') {
          const resolved = typeof patch === 'function' ? patch(copy[i]) : patch
          copy[i] = { ...copy[i], ...resolved }
          break
        }
      }
      return copy
    })
  }

  async function openStream(sid: string) {
    esRef.current?.close()

    const es = new EventSource(`/api/stream/${sid}`)
    esRef.current = es

    // placeholder assistant message
    appendMsg({ id: uid(), role: 'assistant', content: '', streaming: true })

    es.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(e.data)

      // Streaming text delta
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          patchLastAssistant(prev => ({ content: (prev.content ?? '') + ev.delta.text, streaming: true }))
        }
        return
      }

      // Complete assistant turn
      if (msg.type === 'assistant') {
        const textBlocks = (msg.message?.content ?? []).filter((b: { type: string }) => b.type === 'text')
        const text = textBlocks.map((b: { text: string }) => b.text).join('')
        if (text) patchLastAssistant({ content: text, streaming: false })
        return
      }

      // Tool use block
      if (msg.type === 'tool_use') {
        appendMsg({
          id: uid(), role: 'tool',
          toolName: msg.name ?? msg.tool_name ?? 'tool',
          input: msg.input,
          content: '',
        })
        return
      }

      // Tool result
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
          return copy
        })
        return
      }

      // Turn complete
      if (msg.type === 'result') {
        patchLastAssistant({ streaming: false })
        setIsStreaming(false)
        es.close()
        esRef.current = null
        fetchMeta()
        return
      }
    })

    es.addEventListener('control_request', (e: MessageEvent) => {
      const req = JSON.parse(e.data) as ControlRequest
      // store resolver in ref so modal callback can use it
      pendingControlRef.current = {
        requestId: req.requestId,
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
      patchLastAssistant({ streaming: false })
      setIsStreaming(false)
      es.close()
      esRef.current = null
    })
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return

    appendMsg({ id: uid(), role: 'user', content: trimmed })
    setInput('')
    setSuggestions([])
    setIsStreaming(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, sessionId: sessionId ?? undefined }),
      })
      const { sessionId: sid } = await res.json()
      setSessionId(sid)
      await openStream(sid)
    } catch (err) {
      appendMsg({ id: uid(), role: 'assistant', content: `Error: ${String(err)}` })
      setIsStreaming(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Autocomplete navigation
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setSuggIdx(prev => {
        if (e.key === 'ArrowDown') return Math.min(prev + 1, suggestions.length - 1)
        return Math.max(prev - 1, 0)
      })
      return
    }
    if (suggestions.length && e.key === 'Tab') {
      e.preventDefault()
      const pick = suggestions[suggIdx >= 0 ? suggIdx : 0]
      setInput(pick + ' ')
      setSuggestions([])
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (suggestions.length && suggIdx >= 0) {
        setInput(suggestions[suggIdx] + ' ')
        setSuggestions([])
        return
      }
      sendMessage(input)
    }
  }

  function injectCommand(cmd: string) {
    setInput(cmd + ' ')
    inputRef.current?.focus()
  }

  function handleDecide(decision: 'allow' | 'allow_always' | 'deny') {
    pendingControlRef.current?.resolve(decision)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar meta={meta} onCommand={injectCommand} />

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {messages.length === 0 && (
            <div style={{
              height: '100%', display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)',
            }}>
              <div style={{ fontSize: '2em', marginBottom: '12px' }}>🏥</div>
              <div style={{ fontSize: '1.1em', fontWeight: 600, marginBottom: '6px' }}>HealthAgent</div>
              <div style={{ fontSize: '0.9em' }}>Clinical AI assistant. Ask anything or use a /skill.</div>
            </div>
          )}
          {messages.map(msg => (
            <ChatMessage
              key={msg.id}
              msg={msg}
              isStreaming={isStreaming}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div style={{ padding: '12px 24px 16px', borderTop: '1px solid var(--border)', position: 'relative' }}>
          {/* Autocomplete dropdown */}
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '100%', left: '24px', right: '24px',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '4px',
              boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
            }}>
              {suggestions.map((s, i) => (
                <div
                  key={s}
                  onClick={() => { setInput(s + ' '); setSuggestions([]); inputRef.current?.focus() }}
                  style={{
                    padding: '8px 14px', cursor: 'pointer', fontSize: '0.88em',
                    background: i === suggIdx ? 'var(--surface2)' : 'transparent',
                    color: i === suggIdx ? 'var(--text)' : 'var(--text-dim)',
                    borderBottom: i < suggestions.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <span style={{ color: 'var(--accent)' }}>{s}</span>
                  {meta?.commands.find(c => `/${c.name}` === s)?.description && (
                    <span style={{ marginLeft: '10px', fontSize: '0.9em', opacity: 0.7 }}>
                      {meta.commands.find(c => `/${c.name}` === s)?.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Waiting for response…' : 'Message HealthAgent… (/ for skills, Shift+Enter for newline)'}
              disabled={isStreaming}
              rows={1}
              style={{
                flex: 1, resize: 'none', background: 'var(--surface2)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                color: 'var(--text)', padding: '10px 14px', fontSize: '0.95em',
                lineHeight: 1.5, outline: 'none', fontFamily: 'inherit',
                maxHeight: '180px', overflowY: 'auto',
                opacity: isStreaming ? 0.6 : 1,
              }}
              onInput={e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 180) + 'px'
              }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isStreaming}
              style={{
                background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 'var(--radius)', padding: '10px 18px',
                cursor: (!input.trim() || isStreaming) ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: '0.9em',
                opacity: (!input.trim() || isStreaming) ? 0.5 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {pendingControl && (
        <PermissionModal req={pendingControl} onDecide={handleDecide} />
      )}
    </div>
  )
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
