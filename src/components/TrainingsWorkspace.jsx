import { useState, useEffect } from 'react'
import Trainings from './Trainings'
import TrainingsKanban from './TrainingsKanban'
import './TrainingsWorkspace.css'

// Mirrors ProjectsWorkspace.jsx (CCS's Workspace ↔ Board shell) exactly.
const VIEWS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'board',     label: 'Board' },
]
const CHILD_TO_VIEW = { 'trainings': 'workspace', 'trainings-kanban': 'board' }

const VIEW_IDS = new Set(VIEWS.map(v => v.id))

export default function TrainingsWorkspace({ navTarget, onClearNav, onRecordSelect, onNavigateApp }) {
  const saved = localStorage.getItem('trainings_view')
  const initial = VIEW_IDS.has(saved) ? saved : 'workspace'
  const [view, setView] = useState(initial)
  const [visited, setVisited] = useState(() => new Set([initial]))
  const [childNav, setChildNav] = useState(null)

  function go(v) {
    setView(v)
    localStorage.setItem('trainings_view', v)
    setVisited(s => { const n = new Set(s); n.add(v); return n })
  }

  // App routes trainings deep-links (command palette / Home) here.
  // recordId → open that training in the workspace; view → force a specific view.
  useEffect(() => {
    if (navTarget?.moduleId !== 'trainings') return
    if (navTarget.recordId) {
      go('workspace')
      setChildNav({ moduleId: 'trainings', recordId: navTarget.recordId })
    } else if (navTarget.view) {
      go(VIEW_IDS.has(navTarget.view) ? navTarget.view : 'workspace')
    } else { return }
    onClearNav?.()
  }, [navTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-view navigation from a child (e.g. "Board →" / "Open in Trainings")
  function handleChildNav(childModuleId, recordId) {
    go(CHILD_TO_VIEW[childModuleId] || 'workspace')
    setChildNav({ moduleId: childModuleId, recordId })
  }
  const clearChildNav = () => setChildNav(null)

  return (
    <div className="tw-root">
      <div className="tw-bar">
        <span className="tw-title">Trainings</span>
        <div className="tw-views">
          {VIEWS.map(vw => (
            <button key={vw.id} className={`tw-view${view === vw.id ? ' active' : ''}`} onClick={() => go(vw.id)}>{vw.label}</button>
          ))}
        </div>
      </div>
      <div className="tw-body">
        {visited.has('workspace') && <div style={{ display: view === 'workspace' ? 'contents' : 'none' }}><Trainings navTarget={childNav} onClearNav={clearChildNav} onNavigateApp={onNavigateApp} onNavigateTo={handleChildNav} onRecordSelect={onRecordSelect} /></div>}
        {visited.has('board') && <div style={{ display: view === 'board' ? 'contents' : 'none' }}><TrainingsKanban navTarget={childNav} onNavigateTo={handleChildNav} onClearNav={clearChildNav} /></div>}
      </div>
    </div>
  )
}
