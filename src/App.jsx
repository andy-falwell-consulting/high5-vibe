import { useState, useEffect } from 'react'
import NavRail from './components/NavRail'
import ProductsAndServicesV2 from './components/ProductsAndServicesV2'
import Contacts from './components/Contacts'
import Inspections from './components/Inspections'
import CCS from './components/CCS'
import CCSv2 from './components/CCSv2'
import CCSKanban from './components/CCSKanban'
import { getAllRecords } from './api/filemaker'
import { RCD_LAYOUT, RCD_CACHE_VERSION, RCD_FIND_QUERY, RCD_SORT } from './config/ccsCache'
import './light-theme.css'

const MODULES = [
  { id: 'contacts', label: 'Contacts', icon: '◉', group: 'Records' },
  { id: 'inspections', label: 'Inspections', icon: '⚑', group: 'Records' },
  { id: 'products', label: 'Products & Services', icon: '◫', group: 'Records' },
  { id: 'ccs', label: 'CCS', icon: '◈', group: 'Projects' },
  { id: 'ccs-v2', label: 'CCS v2', icon: '✦', group: 'Projects' },
  { id: 'ccs-kanban', label: 'CCS Kanban', icon: '⊞', group: 'Projects' },
]

function getInitialTheme() {
  return localStorage.getItem('theme') ?? 'dark'
}

export default function App() {
  const [activeModule, setActiveModule] = useState('contacts')
  const [visited, setVisited] = useState(() => new Set(['contacts']))
  const [theme, setTheme] = useState(getInitialTheme)
  const [navTarget, setNavTarget] = useState(null)

  // Pre-warm all module caches on startup so every tab loads instantly
  useEffect(() => {
    getAllRecords(RCD_LAYOUT, { cacheVersion: RCD_CACHE_VERSION, findQuery: RCD_FIND_QUERY, sort: RCD_SORT }).catch(() => {})
    getAllRecords('Contacts_New', { cacheVersion: 2, batchSize: 100 }).catch(() => {})
    getAllRecords('Inspections_New', { cacheVersion: 1, batchSize: 100 }).catch(() => {})
    getAllRecords('Products & Services_New', { cacheVersion: 4, batchSize: 100 }).catch(() => {})
  }, [])

  function handleSelect(id) {
    setActiveModule(id)
    setVisited(v => { const n = new Set(v); n.add(id); return n })
  }

  function navigateTo(moduleId, recordId) {
    setNavTarget({ moduleId, recordId })
    handleSelect(moduleId)
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
        <NavRail modules={MODULES} activeId={activeModule} onSelect={handleSelect} theme={theme} onToggleTheme={toggleTheme} />
        {visited.has('contacts') && <div style={{ display: activeModule === 'contacts' ? 'contents' : 'none' }}><Contacts /></div>}
        {visited.has('inspections') && <div style={{ display: activeModule === 'inspections' ? 'contents' : 'none' }}><Inspections /></div>}
        {visited.has('products') && <div style={{ display: activeModule === 'products' ? 'contents' : 'none' }}><ProductsAndServicesV2 /></div>}
        {visited.has('ccs') && <div style={{ display: activeModule === 'ccs' ? 'contents' : 'none' }}><CCS navTarget={navTarget} onNavigateTo={navigateTo} onClearNav={clearNavTarget} /></div>}
        {visited.has('ccs-v2') && <div style={{ display: activeModule === 'ccs-v2' ? 'contents' : 'none' }}><CCSv2 navTarget={navTarget} onNavigateTo={navigateTo} onClearNav={clearNavTarget} /></div>}
        {visited.has('ccs-kanban') && <div style={{ display: activeModule === 'ccs-kanban' ? 'contents' : 'none' }}><CCSKanban navTarget={navTarget} onNavigateTo={navigateTo} onClearNav={clearNavTarget} /></div>}
    </div>
  )
}
