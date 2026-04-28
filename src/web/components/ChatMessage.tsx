import { StreamingText } from './StreamingText.js'
import type { ChatMsg } from '../types.js'

type Props = {
  msg: ChatMsg
  isStreaming: boolean
}

export function ChatMessage({ msg, isStreaming }: Props) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <div
          style={{
            background: 'var(--user-bubble)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            maxWidth: '75%',
            fontSize: '0.95em',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {msg.content}
        </div>
      </div>
    )
  }

  if (msg.role === 'tool') {
    return (
      <div style={{ marginBottom: '8px' }}>
        <details style={{ background: 'var(--tool-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          <summary
            style={{
              padding: '7px 12px',
              cursor: 'pointer',
              fontSize: '0.82em',
              color: 'var(--text-dim)',
              userSelect: 'none',
              listStyle: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>⚙</span>
            <span style={{ fontWeight: 500 }}>{msg.toolName}</span>
            <span style={{ marginLeft: 'auto', fontSize: '0.9em' }}>▼</span>
          </summary>
          <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
            {msg.input && (
              <pre style={{ fontSize: '0.82em', color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                {JSON.stringify(msg.input, null, 2)}
              </pre>
            )}
            {msg.content && (
              <div style={{ marginTop: msg.input ? '8px' : 0, fontSize: '0.85em', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {msg.content}
              </div>
            )}
          </div>
        </details>
      </div>
    )
  }

  // assistant
  return (
    <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', alignItems: 'flex-start' }}>
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          background: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.75em',
          fontWeight: 700,
          flexShrink: 0,
          marginTop: '2px',
        }}
      >
        HA
      </div>
      <div style={{ flex: 1, minWidth: 0, fontSize: '0.95em', lineHeight: 1.6 }}>
        <StreamingText text={msg.content} streaming={isStreaming && msg.streaming} />
        {isStreaming && msg.streaming && !msg.content && (
          <span style={{ color: 'var(--text-dim)', fontSize: '0.9em' }}>Thinking…</span>
        )}
      </div>
    </div>
  )
}
