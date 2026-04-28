import { useState } from 'react'
import { StreamingText } from './StreamingText.js'
import type { ChatMsg } from '../types.js'

type Props = { msg: ChatMsg; isStreaming: boolean }

export function ChatMessage({ msg, isStreaming }: Props) {
  const [open, setOpen] = useState(false)

  if (msg.role === 'user') {
    return (
      <div className="fade-in" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <div style={{
          background: 'var(--user-bg)', color: 'var(--user-text)',
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 16px', maxWidth: '72%',
          fontSize: '0.95em', lineHeight: 1.55,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          boxShadow: 'var(--shadow-sm)',
        }}>
          {msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'tool') {
    const hasResult = Boolean(msg.content)
    return (
      <div className="fade-in" style={{ marginBottom: '8px', marginLeft: '40px' }}>
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', overflow: 'hidden',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              width: '100%', padding: '8px 12px',
              background: 'none', border: 'none', textAlign: 'left',
              color: 'var(--text-dim)', fontSize: '0.82em',
            }}
          >
            <span style={{
              width: '20px', height: '20px', borderRadius: '50%',
              background: 'var(--accent-light)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </span>
            <span style={{ fontWeight: 500, color: 'var(--text)', fontSize: '0.88em' }}>
              {msg.toolName}
            </span>
            {hasResult && (
              <span style={{ marginLeft: 'auto', color: 'var(--success)', fontSize: '0.8em', fontWeight: 500 }}>
                ✓ Done
              </span>
            )}
            {!hasResult && (
              <span style={{
                marginLeft: 'auto', width: '12px', height: '12px',
                border: '2px solid var(--accent)', borderTopColor: 'transparent',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
                display: 'inline-block',
              }} />
            )}
            <span style={{ color: 'var(--text-xdim)', fontSize: '0.9em', marginLeft: hasResult ? '8px' : 0 }}>
              {open ? '▲' : '▼'}
            </span>
          </button>
          {open && (
            <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border-light)', background: 'var(--surface2)' }}>
              {msg.input && Object.keys(msg.input).length > 0 && (
                <div style={{ marginBottom: msg.content ? '10px' : 0 }}>
                  <div style={{ fontSize: '0.75em', fontWeight: 600, color: 'var(--text-xdim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Input</div>
                  <pre style={{ fontSize: '0.82em', color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, fontFamily: 'monospace' }}>
                    {JSON.stringify(msg.input, null, 2)}
                  </pre>
                </div>
              )}
              {msg.content && (
                <div>
                  <div style={{ fontSize: '0.75em', fontWeight: 600, color: 'var(--text-xdim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Result</div>
                  <div style={{ fontSize: '0.85em', color: 'var(--text)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflowY: 'auto' }}>
                    {msg.content.length > 1200 ? msg.content.slice(0, 1200) + '…' : msg.content}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // assistant
  return (
    <div className="fade-in" style={{ display: 'flex', gap: '12px', marginBottom: '16px', alignItems: 'flex-start' }}>
      <div style={{
        width: '30px', height: '30px', borderRadius: '50%',
        background: 'linear-gradient(135deg, #2563eb, #7c3aed)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.68em', fontWeight: 700, color: '#fff', flexShrink: 0,
        marginTop: '1px', boxShadow: 'var(--shadow-sm)',
        letterSpacing: '-0.02em',
      }}>
        VA
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: '4px' }}>
        {isStreaming && msg.streaming && !msg.content ? (
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', height: '22px' }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: 'var(--text-xdim)',
                animation: `blink 1.2s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        ) : (
          <StreamingText text={msg.content} streaming={isStreaming && msg.streaming} />
        )}
      </div>
    </div>
  )
}
