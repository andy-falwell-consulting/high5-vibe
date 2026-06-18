import { useState } from 'react'
import EnvSwitcher from './components/EnvSwitcher'
import NavRail from './components/NavRail'
import ProductsAndServicesV2 from './components/ProductsAndServicesV2'
import Contacts from './components/Contacts'
import CCS from './components/CCS'
import CCSKanban from './components/CCSKanban'
import './light-theme.css'

const MODULES = [
  { id: 'contacts', label: 'Contacts', icon: '◉' },
  { id: 'products', label: 'Products & Services', icon: '📦' },
  { id: 'ccs', label: 'CCS', icon: '◈' },
  { id: 'ccs-kanban', label: 'CCS Kanban', icon: '⊞' },
]

function getInitialTheme() {
  return localStorage.getItem('theme') ?? 'dark'
}

export default function App() {
  const [activeModule, setActiveModule] = useState('contacts')
  const [visited, setVisited] = useState(() => new Set(['contacts']))
  const [theme, setTheme] = useState(getInitialTheme)

  function handleSelect(id) {
    setActiveModule(id)
    setVisited(v => { const n = new Set(v); n.add(id); return n })
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
  }

  return (
    <div data-theme={theme} style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <EnvSwitcher theme={theme} onToggleTheme={toggleTheme} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <NavRail modules={MODULES} activeId={activeModule} onSelect={handleSelect} theme={theme} />
        {visited.has('contacts') && <div style={{ display: activeModule === 'contacts' ? 'contents' : 'none' }}><Contacts /></div>}
        {visited.has('products') && <div style={{ display: activeModule === 'products' ? 'contents' : 'none' }}><ProductsAndServicesV2 /></div>}
        {visited.has('ccs') && <div style={{ display: activeModule === 'ccs' ? 'contents' : 'none' }}><CCS /></div>}
        {visited.has('ccs-kanban') && <div style={{ display: activeModule === 'ccs-kanban' ? 'contents' : 'none' }}><CCSKanban /></div>}
      </div>
    </div>
  )
}
