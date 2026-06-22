import { useState, useEffect } from 'react'
import CCS from './CCS'
import CCSv2 from './CCSv2'
import CCSKanban from './CCSKanban'
import './ProjectsWorkspace.css'

const VIEWS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'list',      label: 'List' },
  { id: 'board',     label: 'Board' },
]
const CHILD_TO_VIEW = { 'ccs-v2': 'workspace', 'ccs': 'list', 'ccs-kanban': 'board' }

export default function ProjectsWorkspace({ navTarget, onClearNav, onRecordSelect }) {
  const initial = localStorage.getItem('projects_view') || 'workspace'
  const [view, setView] = useState(initial)
  const [visited, setVisited] = useState(() => new Set([initial]))
  const [childNav, setChildNav] = useState(null)

  function go(v) {
    setView(v)
    localStorage.setItem('projects_view', v)
    setVisited(s => { const n = new Set(s); n.add(v); return n })
  }

  // App routes project deep-links (command palette / Home) here.
  // recordId → open that project in the workspace; view → force a specific view.
  useEffect(() => {
    if (navTarget?.moduleId !== 'projects') return
    if (navTarget.recordId) {
      go('workspace')
      setChildNav({ moduleId: 'ccs-v2', recordId: navTarget.recordId })
    } else if (navTarget.view) {
      go(navTarget.view)
    } else { return }
    onClearNav?.()
  }, [navTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-view navigation from a child (e.g. "View on board")
  function handleChildNav(childModuleId, recordId) {
    go(CHILD_TO_VIEW[childModuleId] || 'workspace')
    setChildNav({ moduleId: childModuleId, recordId })
  }
  const clearChildNav = () => setChildNav(null)

  return (
    <div className="pw-root">
      <div className="pw-bar">
        <span className="pw-title">Course projects</span>
        <div className="pw-views">
          {VIEWS.map(vw => (
            <button key={vw.id} className={`pw-view${view === vw.id ? ' active' : ''}`} onClick={() => go(vw.id)}>{vw.label}</button>
          ))}
        </div>
      </div>
      <div className="pw-body">
        {visited.has('workspace') && <div style={{ display: view === 'workspace' ? 'contents' : 'none' }}><CCSv2 navTarget={childNav} onNavigateTo={handleChildNav} onClearNav={clearChildNav} onRecordSelect={onRecordSelect} /></div>}
        {visited.has('list') && <div style={{ display: view === 'list' ? 'contents' : 'none' }}><CCS navTarget={childNav} onNavigateTo={handleChildNav} onClearNav={clearChildNav} /></div>}
        {visited.has('board') && <div style={{ display: view === 'board' ? 'contents' : 'none' }}><CCSKanban navTarget={childNav} onNavigateTo={handleChildNav} onClearNav={clearChildNav} /></div>}
      </div>
    </div>
  )
}
