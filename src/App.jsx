import { useState, useEffect } from 'react'
import NavRail from './components/NavRail'
import Home from './components/Home'
import ProductsAndServicesV2 from './components/ProductsAndServicesV2'
import Contacts from './components/Contacts'
import Inspections from './components/Inspections'
import Trainings from './components/Trainings'
import ProjectsWorkspace from './components/ProjectsWorkspace'
import Admin from './components/Admin'
import CommandPalette from './components/CommandPalette'
import AgentPanel from './components/AgentPanel'
import { getAllRecords } from './api/filemaker'
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from './config/ccsCache'
import './light-theme.css'
import './components/CommandPalette.css'

const MODULES = [
  { id: 'home', label: 'Home', icon: '⌂', group: 'Overview' },
  { id: 'contacts', label: 'Contacts', icon: '◉', group: 'Records' },
  { id: 'inspections', label: 'Inspections', icon: '⚑', group: 'Records' },
  { id: 'trainings', label: 'Trainings', icon: '◳', group: 'Records' },
  { id: 'products', label: 'Products & Services', icon: '◫', group: 'Records' },
  { id: 'projects', label: 'Course projects', icon: '◈', group: 'Projects' },
  { id: 'admin', label: 'Admin', icon: '⚙', group: 'System' },
]

function getInitialTheme() {
  return localStorage.getItem('theme') ?? 'dark'
}

export default function App() {
  const [activeModule, setActiveModule] = useState('home')
  const [visited, setVisited] = useState(() => new Set(['home']))
  const [theme, setTheme] = useState(getInitialTheme)
  const [navTarget, setNavTarget] = useState(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)

  // Pre-warm all module caches on startup so every tab loads instantly
  useEffect(() => {
    getAllRecords(RCD_LAYOUT, { cacheVersion: RCD_CACHE_VERSION, findQuery: RCD_FIND_QUERY, sort: RCD_SORT }).catch(() => {})
    getAllRecords('Contacts_New', { cacheVersion: 2, batchSize: 100 }).catch(() => {})
    getAllRecords('Inspections_New', { cacheVersion: 1, batchSize: 100 }).catch(() => {})
    getAllRecords('trainings_New', { cacheVersion: 1, batchSize: 100 }).catch(() => {})
    getAllRecords('Products & Services_New', { cacheVersion: 4, batchSize: 100 }).catch(() => {})
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

  function handleSelect(id) {
    setActiveModule(id)
    setVisited(v => { const n = new Set(v); n.add(id); return n })
  }

  function navigateTo(moduleId, recordId, view) {
    setNavTarget({ moduleId, recordId, view })
    handleSelect(moduleId)
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

  return (
    <div data-theme={theme} style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <NavRail modules={MODULES} activeId={activeModule} onSelect={handleSelect} theme={theme} onToggleTheme={toggleTheme} onOpenPalette={() => setPaletteOpen(true)} />
        {visited.has('home') && <div style={{ display: activeModule === 'home' ? 'contents' : 'none' }}><Home onOpen={handlePalettePick} onGoto={handleSelect} onOpenView={(m, v) => navigateTo(m, null, v)} onOpenPalette={() => setPaletteOpen(true)} /></div>}
        {visited.has('contacts') && <div style={{ display: activeModule === 'contacts' ? 'contents' : 'none' }}><Contacts navTarget={navTarget} onClearNav={clearNavTarget} onNavigateTo={navigateTo} /></div>}
        {visited.has('inspections') && <div style={{ display: activeModule === 'inspections' ? 'contents' : 'none' }}><Inspections navTarget={navTarget} onClearNav={clearNavTarget} /></div>}
        {visited.has('trainings') && <div style={{ display: activeModule === 'trainings' ? 'contents' : 'none' }}><Trainings navTarget={navTarget} onClearNav={clearNavTarget} /></div>}
        {visited.has('products') && <div style={{ display: activeModule === 'products' ? 'contents' : 'none' }}><ProductsAndServicesV2 navTarget={navTarget} onClearNav={clearNavTarget} /></div>}
        {visited.has('projects') && <div style={{ display: activeModule === 'projects' ? 'contents' : 'none' }}><ProjectsWorkspace navTarget={navTarget} onClearNav={clearNavTarget} /></div>}
        {visited.has('admin') && <div style={{ display: activeModule === 'admin' ? 'contents' : 'none' }}><Admin /></div>}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={handlePalettePick} modules={MODULES} theme={theme} onToggleTheme={toggleTheme} />
        {!agentOpen && <button className="agent-fab" onClick={() => setAgentOpen(true)} title="Ask the assistant">✦</button>}
        <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} onOpenRecord={(m, id) => navigateTo(m, id)} />
    </div>
  )
}
