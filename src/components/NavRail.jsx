/* global __APP_VERSION__ */
import { useState, useEffect, useCallback, useRef } from 'react'
import { FMP_ENVIRONMENTS, getCurrentEnv, setCurrentEnvId } from '../config/fmpEnvironments'
import { getFmpUserName, setFmpUserSession, ensureFmpUserSession } from '../api/filemaker'

const MIN_WIDTH = 48
const COLLAPSED_WIDTH = 56
const DEFAULT_WIDTH = 196

const ENV_DOT = { development: '#22c55e', staging: '#f59e0b', production: '#ef4444' }

export default function NavRail({ modules, activeId, onSelect, theme, onToggleTheme, onOpenPalette, user, onLogout, badges = {} }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [fmpName, setFmpName] = useState(() => getFmpUserName())
  const [fmpBusy, setFmpBusy] = useState(false)
  const [fmpError, setFmpError] = useState(null)
  // First-run nudge on the search bar — shown once until the user opens search or dismisses it.
  const [searchHint, setSearchHint] = useState(() => { try { return !localStorage.getItem('belay_search_hint_v1') } catch { return false } })
  const dismissSearchHint = useCallback(() => { try { localStorage.setItem('belay_search_hint_v1', '1') } catch { /* ignore */ } setSearchHint(false) }, [])

  // Auto-connect the user's FileMaker write identity on mount (server mints a
  // user-bound token via Basic auth). Silent; falls back to admin if no account.
  useEffect(() => {
    let alive = true
    if (!getFmpUserName()) {
      ensureFmpUserSession().then(name => { if (alive && name) setFmpName(name) }).catch(() => {})
    }
    return () => { alive = false }
  }, [])
  const dragStart = useRef(null)
  const userMenuRef = useRef(null)
  const light = theme === 'light'

  const displayWidth = collapsed ? COLLAPSED_WIDTH : width
  const showLabels = !collapsed && width > 90

  const env = getCurrentEnv()
  const envDot = ENV_DOT[env.id] || '#64748b'
  const isProd = env.id === 'production'

  // Derive display name and initials from Google user or env fallback
  const displayName = user?.name || env.user || 'user'
  const userInitials = displayName.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return
    const onDown = e => { if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [userMenuOpen])

  // Theme tokens
  const c = light ? {
    bg: '#f4f6f8', border: '#e2e8f0', text: '#4f5a69', textActive: '#0f172a',
    activeBg: '#ffffff', divider: '#e2e8f0', mutedLabel: '#5e6b7c', sub: '#5e6b7c',
    footerBtn: '#ffffff', footerBorder: '#e2e8f0',
  } : {
    bg: '#0b0d14', border: '#1e2130', text: '#8b97aa', textActive: '#e2e8f0',
    activeBg: '#161926', divider: '#1e2130', mutedLabel: '#79859a', sub: '#79859a',
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

  async function connectFmp() {
    setFmpBusy(true); setFmpError(null)
    try {
      const name = await ensureFmpUserSession()
      if (name) setFmpName(name)
      else setFmpError('No FileMaker account for your email')
    } catch (err) {
      setFmpError(err.message || 'Could not connect')
    } finally {
      setFmpBusy(false)
    }
  }

  function disconnectFmp() {
    setFmpUserSession(null)
    setFmpName(null)
    setFmpError(null)
  }

  const navItem = (mod) => {
    const active = mod.id === activeId
    const badge = badges[mod.id] || 0
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
        <span style={{ position: 'relative', fontSize: 20, flexShrink: 0, color: active ? '#e8322a' : 'inherit', width: 18, textAlign: 'center' }}>
          {mod.icon}
          {badge > 0 && !showLabels && (
            <span style={{ position: 'absolute', top: -3, right: -4, width: 8, height: 8, borderRadius: '50%', background: '#e8322a', border: `1.5px solid ${active ? c.activeBg : c.bg}` }} />
          )}
        </span>
        {showLabels && (
          <span style={{ fontSize: 15, fontWeight: active ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{mod.label}</span>
        )}
        {showLabels && badge > 0 && (
          <span style={{ flexShrink: 0, minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 9, background: '#e8322a', color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{badge > 99 ? '99+' : badge}</span>
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
            fontFamily: "'Oswald', sans-serif", fontSize: 17, fontWeight: 700,
            border: '1px solid #333', flexShrink: 0,
          }}>V</span>
          {showLabels && (
            <div style={{ lineHeight: 1.2, minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 600, color: c.textActive }}>Vibe</div>
            </div>
          )}
          {showLabels && (
            <button onClick={() => setCollapsed(true)} title="Collapse"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: c.mutedLabel, fontSize: 18, lineHeight: 1, padding: 2 }}>«</button>
          )}
        </div>

        {/* ── Command palette trigger ── */}
        <div style={{ position: 'relative', padding: showLabels ? '0 10px 8px' : '0 0 8px', display: 'flex', justifyContent: 'center' }}>
          {searchHint && showLabels && (
            <div style={{ position: 'absolute', top: 'calc(100% - 2px)', left: 10, right: 10, background: '#e8322a', color: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 13, lineHeight: 1.35, boxShadow: '0 6px 18px rgba(0,0,0,0.28)', zIndex: 20 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ flex: 1 }}><strong>✦ New:</strong> ask the assistant anything here — invoices, projects, email &amp; more.</span>
                <button onClick={dismissSearchHint} aria-label="Dismiss" style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, opacity: 0.85 }}>✕</button>
              </div>
              <span style={{ position: 'absolute', bottom: '100%', left: 22, width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderBottom: '6px solid #e8322a' }} />
            </div>
          )}
          {showLabels ? (
            <button onClick={() => { dismissSearchHint(); onOpenPalette() }} title="Search or ask the assistant (⌘K)"
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 9px', background: c.footerBtn, border: `1px solid ${c.footerBorder}`, borderRadius: 8, cursor: 'pointer', color: c.mutedLabel }}>
              <span style={{ fontSize: 18 }}>⌕</span>
              <span style={{ flex: 1, textAlign: 'left', fontSize: 15 }}>Search or ask…</span>
              <span style={{ fontFamily: 'monospace', fontSize: 13, border: `1px solid ${c.divider}`, borderRadius: 4, padding: '1px 5px' }}>⌘K</span>
            </button>
          ) : (
            <button onClick={() => { dismissSearchHint(); onOpenPalette() }} title="Search or ask the assistant (⌘K)"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 30, background: 'none', border: 'none', cursor: 'pointer', color: c.mutedLabel, fontSize: 20 }}>⌕</button>
          )}
        </div>

        {/* ── Grouped nav ── */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 8px' }}>
          {!showLabels && (
            <button onClick={() => { setCollapsed(false); setWidth(w => Math.max(w, DEFAULT_WIDTH)) }} title="Expand"
              style={{ display: 'flex', justifyContent: 'center', width: '100%', padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer', color: c.mutedLabel, fontSize: 18 }}>»</button>
          )}
          {order.map((g, gi) => (
            <div key={g} style={{ marginBottom: 6 }}>
              {showLabels ? (
                <div style={{ fontSize: 13, fontWeight: 600, color: c.mutedLabel, letterSpacing: '0.04em', padding: gi === 0 ? '4px 10px 5px' : '12px 10px 5px' }}>{g}</div>
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
                style={{ flex: 1, appearance: 'none', background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 500, color: c.textActive, fontFamily: 'inherit' }}>
                {FMP_ENVIRONMENTS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              <span style={{ color: c.mutedLabel, fontSize: 14, pointerEvents: 'none' }}>⌄</span>
            </div>
          ) : (
            <span title={env.label} style={{ width: 9, height: 9, borderRadius: '50%', background: envDot }} />
          )}

          {showLabels ? (
            <div style={{ position: 'relative' }} ref={userMenuRef}>
              <button onClick={() => setUserMenuOpen(o => !o)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                {user?.picture
                  ? <img src={user.picture} referrerPolicy="no-referrer" alt={displayName} style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }} />
                  : <span style={{ width: 24, height: 24, borderRadius: '50%', background: light ? '#e2e8f0' : '#1e2130', color: c.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{userInitials}</span>
                }
                <div style={{ flex: 1, minWidth: 0, lineHeight: 1.15 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: c.textActive, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                  <div style={{ fontSize: 12, color: c.sub }}>v{__APP_VERSION__}</div>
                </div>
              </button>
              {userMenuOpen && (
                <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, background: light ? '#ffffff' : '#13151c', border: `1px solid ${light ? '#e2e8f0' : '#1e2130'}`, borderRadius: 8, overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 100 }}>
                  {user?.email && <div style={{ padding: '8px 12px', fontSize: 13, color: c.sub, borderBottom: `1px solid ${light ? '#e2e8f0' : '#1e2130'}` }}>{user.email}</div>}

                  {/* FileMaker write attribution */}
                  <div style={{ padding: '8px 12px', borderBottom: `1px solid ${light ? '#e2e8f0' : '#1e2130'}` }}>
                    <div style={{ fontSize: 12, color: c.mutedLabel, marginBottom: 4, letterSpacing: '0.04em' }}>FILEMAKER EDITS</div>
                    {fmpName ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} title="Edits attributed to you" />
                        <span style={{ flex: 1, fontSize: 14, color: c.textActive, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmpName}</span>
                        <button onClick={disconnectFmp}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: c.sub }}>Use admin</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#64748b', flexShrink: 0 }} />
                        <span style={{ flex: 1, fontSize: 14, color: c.sub }}>Saving as admin</span>
                        <button onClick={connectFmp} disabled={fmpBusy}
                          style={{ background: 'none', border: 'none', cursor: fmpBusy ? 'default' : 'pointer', fontSize: 13, color: c.text }}>{fmpBusy ? '…' : 'Connect'}</button>
                      </div>
                    )}
                    {fmpError && <div style={{ fontSize: 12, color: '#e8322a', marginTop: 5, wordBreak: 'break-word' }}>{fmpError}</div>}
                  </div>

                  <button onClick={onToggleTheme}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: c.text, textAlign: 'left' }}>
                    {light ? '🌙' : '☀️'} {light ? 'Dark mode' : 'Light mode'}
                  </button>
                  {onLogout && (
                    <button onClick={() => { setUserMenuOpen(false); onLogout() }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'none', border: 'none', borderTop: `1px solid ${light ? '#e2e8f0' : '#1e2130'}`, cursor: 'pointer', fontSize: 14, color: '#e8322a', textAlign: 'left' }}>
                      Sign out
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <button onClick={onToggleTheme} title={light ? 'Dark mode' : 'Light mode'}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 3, opacity: 0.75 }}>{light ? '🌙' : '☀️'}</button>
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
