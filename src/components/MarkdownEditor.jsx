import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './MarkdownEditor.css'

// A small Markdown editor with a live preview.
//
// Markdown rather than an HTML editor on purpose. These are customer e-mails
// written by staff, and a rich-text editor produces markup nobody can inspect —
// when a message looks wrong in someone's inbox there is no readable source to
// check. Markdown stays legible, diffs cleanly, and the server renders it to a
// known set of tags with inline styles, which is what e-mail clients need.
//
// The preview here uses react-markdown, which is already in the app. It is a
// FAITHFUL-ENOUGH preview, not the delivered HTML — the server's renderer is the
// authority, and the send dialog shows that one.
//
// SINGLE NEWLINES ARE LINE BREAKS, matching the server. Standard Markdown wants
// two trailing spaces for a hard break, which nobody writing an e-mail will type
// because they cannot see them. `hardBreaks` adds that syntax just before
// rendering so the preview shows what the server will send — a preview that
// silently collapses the lines a writer just typed is worse than none, because
// it teaches them the wrong thing about their own text.

const TOOLS = [
  { label: 'B', title: 'Bold', wrap: ['**', '**'], className: 'mde-b' },
  { label: 'I', title: 'Italic', wrap: ['*', '*'], className: 'mde-i' },
  { label: 'H2', title: 'Heading', line: '## ' },
  { label: '•', title: 'Bullet list', line: '- ' },
  { label: '1.', title: 'Numbered list', line: '1. ' },
  { label: '🔗', title: 'Link', wrap: ['[', '](https://)'] },
  { label: '❝', title: 'Quote', line: '> ' },
  { label: '—', title: 'Divider', block: '\n---\n' },
]

// Two trailing spaces on every line that is followed by another non-blank line.
// Blank lines are untouched, so paragraphs still separate normally.
const hardBreaks = md => String(md ?? '')
  .replace(/\r\n?/g, '\n')
  .split('\n')
  .map((line, i, all) => {
    const next = all[i + 1];
    return line.trim() && next !== undefined && next.trim() ? line + '  ' : line;
  })
  .join('\n');

export default function MarkdownEditor({ value, onChange, disabled, rows = 14, tokens = [], placeholder }) {
  const ref = useRef(null)
  const [tab, setTab] = useState('write')

  // Applies a tool at the cursor and puts the caret back where the writer
  // expects it — an editor that loses your place after every button is one you
  // stop using.
  function apply(tool) {
    const el = ref.current
    if (!el) return
    const v = value ?? ''
    const start = el.selectionStart ?? v.length
    const end = el.selectionEnd ?? start
    let next, caret

    if (tool.wrap) {
      const [a, b] = tool.wrap
      const sel = v.slice(start, end)
      next = v.slice(0, start) + a + sel + b + v.slice(end)
      caret = sel ? start + a.length + sel.length + b.length : start + a.length
    } else if (tool.line) {
      const lineStart = v.lastIndexOf('\n', Math.max(0, start - 1)) + 1
      next = v.slice(0, lineStart) + tool.line + v.slice(lineStart)
      caret = start + tool.line.length
    } else {
      next = v.slice(0, start) + tool.block + v.slice(end)
      caret = start + tool.block.length
    }
    onChange(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret) })
  }

  function insertToken(t) {
    const el = ref.current
    const v = value ?? ''
    const at = el?.selectionStart ?? v.length
    const snippet = `{{${t}}}`
    onChange(v.slice(0, at) + snippet + v.slice(el?.selectionEnd ?? at))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + snippet.length, at + snippet.length) })
  }

  return (
    <div className="mde">
      <div className="mde-bar">
        <div className="mde-tools">
          {TOOLS.map(t => (
            <button key={t.label} type="button" className={`mde-tool ${t.className || ''}`}
              title={t.title} disabled={disabled || tab === 'preview'}
              onMouseDown={e => e.preventDefault()} onClick={() => apply(t)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="mde-tabs">
          <button type="button" className={`mde-tab${tab === 'write' ? ' active' : ''}`}
            onClick={() => setTab('write')}>Write</button>
          <button type="button" className={`mde-tab${tab === 'preview' ? ' active' : ''}`}
            onClick={() => setTab('preview')}>Preview</button>
        </div>
      </div>

      {tab === 'write' ? (
        <textarea ref={ref} className="mde-input" rows={rows} disabled={disabled}
          placeholder={placeholder} value={value ?? ''} onChange={e => onChange(e.target.value)} />
      ) : (
        <div className="mde-preview">
          {String(value ?? '').trim()
            ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{hardBreaks(value)}</ReactMarkdown>
            : <p className="mde-empty">Nothing to preview yet.</p>}
        </div>
      )}

      {tokens.length > 0 && (
        <div className="mde-tokens">
          <span>Insert:</span>
          {tokens.map(t => (
            <button key={t} type="button" className="mde-token" disabled={disabled || tab === 'preview'}
              onMouseDown={e => e.preventDefault()} onClick={() => insertToken(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
