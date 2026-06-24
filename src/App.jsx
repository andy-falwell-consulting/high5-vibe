import { useState, useEffect } from 'react'
import NavRail from './components/NavRail'
import LoginScreen from './components/LoginScreen'
import Home from './components/Home'
import ProductsAndServicesV2 from './components/ProductsAndServicesV2'
import Contacts from './components/Contacts'
import Inspections from './components/Inspections'
import Trainings from './components/Trainings'
import OELookup from './components/OELookup'
import ProjectsWorkspace from './components/ProjectsWorkspace'
import Estimates from './components/Estimates'
import RMI from './components/RMI'
import Admin from './components/Admin'
import CommandPalette from './components/CommandPalette'
import AgentPanel from './components/AgentPanel'
import { getAllRecords, ensureFmpUserSession } from './api/filemaker'
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from './config/ccsCache'
import './light-theme.css'
import './components/CommandPalette.css'

const MODULES = [
  { id: 'home', label: 'Home', icon: '⌂', group: 'Overview' },
  { id: 'contacts', label: 'Contacts', icon: '◉', group: 'Records' },
  { id: 'estimates',   label: 'Estimates',   icon: '◧', group: 'Records' },
  { id: 'inspections', label: 'Inspections', icon: '⚑', group: 'Records' },
  { id: 'rmi',         label: 'Risk Management', icon: '⚠', group: 'Records' },
  { id: 'trainings', label: 'Trainings', icon: '◳', group: 'Records' },
  { id: 'oe-lookup', label: 'OE Lookup', icon: '◎', group: 'Records' },
  { id: 'products', label: 'Products & Services', icon: '◫', group: 'Records' },
  { id: 'projects', label: 'Course projects', icon: '◈', group: 'Projects' },
  { id: 'admin', label: 'Admin', icon: '⚙', group: 'System' },
]

const MODULE_IDS = new Set(MODULES.map(m => m.id))

function parseHash() {
  const raw = window.location.hash.slice(1) // strip leading #
  const [moduleId, recordId] = raw.split('/')
  const mod = MODULE_IDS.has(moduleId) ? moduleId : 'home'
  return { moduleId: mod, recordId: recordId || null }
}

function getInitialTheme() {
  return localStorage.getItem('theme') ?? 'dark'
}

export default function App() {
  const initial = parseHash()
  const [activeModule, setActiveModule] = useState(initial.moduleId)
  const [visited, setVisited] = useState(() => new Set([initial.moduleId]))
  const [theme, setTheme] = useState(getInitialTheme)
  const [navTarget, setNavTarget] = useState(initial.recordId ? { moduleId: initial.moduleId, recordId: initial.recordId } : null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  // Auth check — /api/me returns 401 if not logged in, 404 in local dev (pass through)
  useEffect(() => {
    fetch('/api/me')
      .then(r => {
        if (r.status === 401) { setAuthChecked(true); return null }
        if (!r.ok) { setAuthChecked(true); return null } // 404 in local dev — allow through
        return r.json()
      })
      .then(u => {
        if (u) {
          setUser(u); setAuthChecked(true)
          // Mint a user-bound FileMaker write token so edits are attributed to
          // this person (falls back to admin silently if no FM account).
          ensureFmpUserSession().catch(() => {})
        }
      })
      .catch(() => setAuthChecked(true)) // network error — allow through
  }, [])

  // Pre-warm module caches so every tab loads instantly — but DEFER it so the
  // module the user actually landed on gets the request scheduler to itself
  // first (the scheduler is 4-concurrent; flooding it at t=0 starves the active
  // list). We also skip the landing module's own layout — its useAllRecords is
  // already fetching it.
  useEffect(() => {
    const PREWARM = [
      { id: 'projects',    layout: RCD_LAYOUT,                opts: { cacheVersion: RCD_CACHE_VERSION, findQuery: RCD_FIND_QUERY, sort: RCD_SORT } },
      { id: 'contacts',    layout: 'Contacts_New',            opts: { cacheVersion: 2, batchSize: 100 } },
      { id: 'estimates',   layout: 'Estimates_New',           opts: { cacheVersion: 1, batchSize: 100 } },
      { id: 'inspections', layout: 'Inspections_New',         opts: { cacheVersion: 1, batchSize: 100 } },
      { id: 'rmi',         layout: 'RMI_New',                 opts: { cacheVersion: 1, batchSize: 100 } },
      { id: 'trainings',   layout: 'trainings_New',           opts: { cacheVersion: 1, batchSize: 100 } },
      { id: 'oe-lookup',   layout: 'OELookup_New',            opts: { cacheVersion: 1, batchSize: 100 } },
      { id: 'products',    layout: 'Products & Services_New', opts: { cacheVersion: 4, batchSize: 100 } },
    ]
    const landing = parseHash().moduleId
    const t = setTimeout(() => {
      PREWARM.filter(s => s.id !== landing)
             .forEach(s => getAllRecords(s.layout, s.opts).catch(() => {}))
    }, 2500)
    return () => clearTimeout(t)
  }, [])

  // Global ⌘K / Ctrl+K to open the command palette
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Browser back/forward
  useEffect(() => {
    const onPop = () => {
      const { moduleId, recordId } = parseHash()
      setActiveModule(moduleId)
      setVisited(v => { const n = new Set(v); n.add(moduleId); return n })
      setNavTarget(recordId ? { moduleId, recordId } : null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function pushHash(moduleId, recordId) {
    const hash = recordId ? `#${moduleId}/${recordId}` : `#${moduleId}`
    if (window.location.hash !== hash) history.pushState(null, '', hash)
  }

  function makeRecordSelectHandler(moduleId) {
    return (recordId) => pushHash(moduleId, recordId)
  }

  function handleSelect(id) {
    pushHash(id, null)
    setActiveModule(id)
    setVisited(v => { const n = new Set(v); n.add(id); return n })
  }

  function navigateTo(moduleId, recordId, view) {
    pushHash(moduleId, recordId)
    setNavTarget({ moduleId, recordId, view })
    setActiveModule(moduleId)
    setVisited(v => { const n = new Set(v); n.add(moduleId); return n })
  }

  function handlePalettePick(moduleId, recordId) {
    if (recordId) navigateTo(moduleId, recordId)
    else handleSelect(moduleId)
  }

  function clearNavTarget() {
    setNavTarget(null)
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
  }

  async function handleLogout() {
    await fetch('/api/google-logout', { method: 'POST' }).catch(() => {})
    setUser(null)
  }

  if (!authChecked) return null

  // Block on deployed app; pass through on localhost (no serverless functions in dev)
  const isLocalDev = window.location.hostname === 'localhost'
  if (!user && !isLocalDev) return <div data-theme={theme}><LoginScreen /></div>

  return (
    <div data-theme={theme} style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <NavRail modules={MODULES} activeId={activeModule} onSelect={handleSelect} theme={theme} onToggleTheme={toggleTheme} onOpenPalette={() => setPaletteOpen(true)} user={user} onLogout={handleLogout} />
        {visited.has('home') && <div style={{ display: activeModule === 'home' ? 'contents' : 'none' }}><Home onOpen={handlePalettePick} onGoto={handleSelect} onOpenView={(m, v) => navigateTo(m, null, v)} onOpenPalette={() => setPaletteOpen(true)} /></div>}
        {visited.has('contacts') && <div style={{ display: activeModule === 'contacts' ? 'contents' : 'none' }}><Contacts navTarget={navTarget} onClearNav={clearNavTarget} onNavigateTo={navigateTo} onRecordSelect={makeRecordSelectHandler('contacts')} /></div>}
        {visited.has('estimates') && <div style={{ display: activeModule === 'estimates' ? 'contents' : 'none' }}><Estimates navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('estimates')} /></div>}
        {visited.has('inspections') && <div style={{ display: activeModule === 'inspections' ? 'contents' : 'none' }}><Inspections navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('inspections')} /></div>}
        {visited.has('rmi') && <div style={{ display: activeModule === 'rmi' ? 'contents' : 'none' }}><RMI navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('rmi')} /></div>}
        {visited.has('trainings') && <div style={{ display: activeModule === 'trainings' ? 'contents' : 'none' }}><Trainings navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('trainings')} /></div>}
        {visited.has('oe-lookup') && <div style={{ display: activeModule === 'oe-lookup' ? 'contents' : 'none' }}><OELookup navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('oe-lookup')} /></div>}
        {visited.has('products') && <div style={{ display: activeModule === 'products' ? 'contents' : 'none' }}><ProductsAndServicesV2 navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('products')} /></div>}
        {visited.has('projects') && <div style={{ display: activeModule === 'projects' ? 'contents' : 'none' }}><ProjectsWorkspace navTarget={navTarget} onClearNav={clearNavTarget} onRecordSelect={makeRecordSelectHandler('projects')} /></div>}
        {visited.has('admin') && <div style={{ display: activeModule === 'admin' ? 'contents' : 'none' }}><Admin /></div>}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={handlePalettePick} modules={MODULES} theme={theme} onToggleTheme={toggleTheme} />
        {!agentOpen && <button className="agent-fab" onClick={() => setAgentOpen(true)} title="Ask the assistant">✦</button>}
        <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} onOpenRecord={(m, id) => navigateTo(m, id)} />
    </div>
  )
}
