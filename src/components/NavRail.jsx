/* global __APP_VERSION__ */
import { useState, useCallback, useRef } from 'react'
import { FMP_ENVIRONMENTS, getCurrentEnv, setCurrentEnvId } from '../config/fmpEnvironments'

const MIN_WIDTH = 48
const COLLAPSED_WIDTH = 56
const DEFAULT_WIDTH = 196

const ENV_DOT = { development: '#22c55e', staging: '#f59e0b', production: '#ef4444' }

export default function NavRail({ modules, activeId, onSelect, theme, onToggleTheme }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(false)
  const dragStart = useRef(null)
  const light = theme === 'light'

  const displayWidth = collapsed ? COLLAPSED_WIDTH : width
  const showLabels = !collapsed && width > 90

  const env = getCurrentEnv()
  const envDot = ENV_DOT[env.id] || '#64748b'
  const isProd = env.id === 'production'
  const user = env.user || 'user'
  const userInitials = user.slice(0, 2).toUpperCase()

  // Theme tokens
  const c = light ? {
    bg: '#f4f6f8', border: '#e2e8f0', text: '#64748b', textActive: '#0f172a',
    activeBg: '#ffffff', divider: '#e2e8f0', mutedLabel: '#94a3b8', sub: '#94a3b8',
    footerBtn: '#ffffff', footerBorder: '#e2e8f0',
  } : {
    bg: '#0b0d14', border: '#1e2130', text: '#64748b', textActive: '#e2e8f0',
    activeBg: '#161926', divider: '#1e2130', mutedLabel: '#475569', sub: '#475569',
    footerBtn: '#13151c', footerBorder: '#1e2130',
  }

  const startResize = useCallback((e) => {
    e.preventDefault()
    dragStart.current = { x: e.clientX, w: width }
    const onMove = (e) => {
      const delta = e.clientX - dragStart.current.x
      const next = Math.max(MIN_WIDTH, dragStart.current.w + delta)
      setWidth(next)
      setCollapsed(next <= 72)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [width])

  // Group modules, preserving first-seen group order
  const order = []
  const byGroup = {}
  modules.forEach(m => {
    const g = m.group || 'General'
    if (!byGroup[g]) { byGroup[g] = []; order.push(g) }
    byGroup[g].push(m)
  })

  function changeEnv(e) {
    setCurrentEnvId(e.target.value)
    window.location.reload()
  }

  const navItem = (mod) => {
    const active = mod.id === activeId
    return (
      <button
        key={mod.id}
        onClick={() => onSelect(mod.id)}
        title={showLabels ? undefined : mod.label}
        style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 11,
          width: '100%', boxSizing: 'border-box',
          padding: showLabels ? '8px 10px 8px 12px' : '9px 0',
          justifyContent: showLabels ? 'flex-start' : 'center',
          background: active ? c.activeBg : 'transparent',
          border: 'none', borderRadius: 8, cursor: 'pointer',
          color: active ? c.textActive : c.text,
          textAlign: 'left', whiteSpace: 'nowrap',
          transition: 'background 0.12s, color 0.12s',
        }}
        onMouseEnter={e => { if (!active) e.currentTarget.style.background = light ? '#eaeef2' : '#11141d' }}
        onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
      >
        {active && showLabels && (
          <span style={{ position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)', width: 3, height: 16, borderRadius: 2, background: '#e8322a' }} />
        )}
        <span style={{ fontSize: 16, flexShrink: 0, color: active ? '#e8322a' : 'inherit', width: 18, textAlign: 'center' }}>{mod.icon}</span>
        {showLabels && (
          <span style={{ fontSize: 12.5, fontWeight: active ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>{mod.label}</span>
        )}
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexShrink: 0, height: '100%' }}>
      <div style={{
        width: displayWidth, flexShrink: 0,
        background: c.bg, borderRight: `1px solid ${c.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* ── Brand header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: showLabels ? '14px 14px 12px' : '14px 0 12px',
          justifyContent: showLabels ? 'flex-start' : 'center',
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: 7, background: '#1a1a1a', color: '#e8322a',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Oswald', sans-serif", fontSize: 13, fontWeight: 700,
            border: '1px solid #333', flexShrink: 0,
          }}>H5</span>
          {showLabels && (
            <div style={{ lineHeight: 1.2, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: c.textActive }}>High5</div>
              <div style={{ fontSize: 11, color: c.sub }}>Core database</div>
            </div>
          )}
          {showLabels && (
            <button onClick={() => setCollapsed(true)} title="Collapse"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: c.mutedLabel, fontSize: 14, lineHeight: 1, padding: 2 }}>«</button>
          )}
        </div>

        {/* ── Grouped nav ── */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 8px' }}>
          {!showLabels && (
            <button onClick={() => { setCollapsed(false); setWidth(w => Math.max(w, DEFAULT_WIDTH)) }} title="Expand"
              style={{ display: 'flex', justifyContent: 'center', width: '100%', padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer', color: c.mutedLabel, fontSize: 14 }}>»</button>
          )}
          {order.map((g, gi) => (
            <div key={g} style={{ marginBottom: 6 }}>
              {showLabels ? (
                <div style={{ fontSize: 10.5, fontWeight: 600, color: c.mutedLabel, letterSpacing: '0.04em', padding: gi === 0 ? '4px 10px 5px' : '12px 10px 5px' }}>{g}</div>
              ) : (
                gi > 0 && <div style={{ height: 1, background: c.divider, margin: '8px 12px' }} />
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {byGroup[g].map(navItem)}
              </div>
            </div>
          ))}
        </div>

        {/* ── Footer: environment · user · theme ── */}
        <div style={{ borderTop: `1px solid ${c.footerBorder}`, padding: showLabels ? 10 : '10px 0', display: 'flex', flexDirection: 'column', gap: 8, alignItems: showLabels ? 'stretch' : 'center' }}>
          {showLabels ? (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, background: c.footerBtn, border: `1px solid ${isProd ? '#ef444466' : c.footerBorder}`, borderRadius: 8, padding: '6px 9px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: envDot, flexShrink: 0 }} />
              <select value={env.id} onChange={changeEnv}
                style={{ flex: 1, appearance: 'none', background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: c.textActive, fontFamily: 'inherit' }}>
                {FMP_ENVIRONMENTS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              <span style={{ color: c.mutedLabel, fontSize: 11, pointerEvents: 'none' }}>⌄</span>
            </div>
          ) : (
            <span title={env.label} style={{ width: 9, height: 9, borderRadius: '50%', background: envDot }} />
          )}

          {showLabels ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 24, height: 24, borderRadius: '50%', background: light ? '#e2e8f0' : '#1e2130', color: c.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>{userInitials}</span>
              <div style={{ flex: 1, minWidth: 0, lineHeight: 1.15 }}>
                <div style={{ fontSize: 12, color: c.textActive, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user}</div>
                <div style={{ fontSize: 10, color: c.sub }}>v{__APP_VERSION__}</div>
              </div>
              <button onClick={onToggleTheme} title={light ? 'Dark mode' : 'Light mode'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 3, opacity: 0.75 }}>{light ? '🌙' : '☀️'}</button>
            </div>
          ) : (
            <button onClick={onToggleTheme} title={light ? 'Dark mode' : 'Light mode'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 3, opacity: 0.75 }}>{light ? '🌙' : '☀️'}</button>
          )}
        </div>
      </div>

      <div
        onMouseDown={startResize}
        style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: c.border, transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#e8322a'}
        onMouseLeave={e => e.currentTarget.style.background = c.border}
      />
    </div>
  )
}
