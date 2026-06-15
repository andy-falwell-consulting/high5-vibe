import { useState, useCallback, useRef } from 'react'

const MIN_WIDTH = 48
const COLLAPSED_WIDTH = 48
const DEFAULT_WIDTH = 180

export default function NavRail({ modules, activeId, onSelect, theme }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(false)
  const dragStart = useRef(null)
  const light = theme === 'light'

  const displayWidth = collapsed ? COLLAPSED_WIDTH : width
  const showLabels = !collapsed && width > 80

  const startResize = useCallback((e) => {
    e.preventDefault()
    dragStart.current = { x: e.clientX, w: width }
    const onMove = (e) => {
      const delta = e.clientX - dragStart.current.x
      const next = Math.max(MIN_WIDTH, dragStart.current.w + delta)
      setWidth(next)
      if (next <= 60) setCollapsed(true)
      else setCollapsed(false)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [width])

  return (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      <div style={{
        width: displayWidth,
        flexShrink: 0,
        background: light ? '#f1f5f9' : '#0b0d14',
        borderRight: `1px solid ${light ? '#e2e8f0' : '#1e2130'}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Toggle */}
        <button
          onClick={() => { setCollapsed(c => !c); if (collapsed) setWidth(Math.max(width, DEFAULT_WIDTH)) }}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: showLabels ? 'flex-end' : 'center',
            padding: '10px 12px',
            background: 'none', border: 'none', cursor: 'pointer',
            color: light ? '#94a3b8' : '#475569',
            borderBottom: `1px solid ${light ? '#e2e8f0' : '#1e2130'}`,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>{showLabels ? '«' : '»'}</span>
        </button>

        {/* Nav items */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
          {modules.map(mod => {
            const active = mod.id === activeId
            return (
              <button
                key={mod.id}
                onClick={() => onSelect(mod.id)}
                title={showLabels ? undefined : mod.label}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '9px 14px',
                  background: active ? (light ? '#e2e8f0' : '#1e2130') : 'none',
                  border: 'none', cursor: 'pointer',
                  color: active ? (light ? '#0f172a' : '#e2e8f0') : '#64748b',
                  textAlign: 'left', whiteSpace: 'nowrap',
                  borderLeft: `2px solid ${active ? '#e8322a' : 'transparent'}`,
                  transition: 'all 0.15s',
                }}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{mod.icon}</span>
                {showLabels && (
                  <span style={{ fontSize: 12, fontWeight: active ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {mod.label}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        style={{
          width: 4, flexShrink: 0, cursor: 'col-resize',
          background: light ? '#e2e8f0' : '#1e2130',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#e8322a'}
        onMouseLeave={e => e.currentTarget.style.background = light ? '#e2e8f0' : '#1e2130'}
      />
    </div>
  )
}
