import { marked } from 'marked'

marked.setOptions({ breaks: true, gfm: true })

type Props = {
  text: string
  streaming?: boolean
}

export function StreamingText({ text, streaming }: Props) {
  if (!text) return null

  if (streaming) {
    return (
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
        {text}
        <span style={{
          display: 'inline-block', width: '2px', height: '1em',
          background: 'var(--accent)', marginLeft: '2px',
          verticalAlign: 'text-bottom', animation: 'blink 1s step-end infinite',
        }} />
      </span>
    )
  }

  const html = marked.parse(text) as string
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
