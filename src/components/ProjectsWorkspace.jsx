import { useState, useEffect } from 'react'
import CCSv2 from './CCSv2'
import CCSKanban from './CCSKanban'
import './ProjectsWorkspace.css'

// The List view was removed on request — nobody used it. Workspace and Board
// are what the team works in.
const VIEWS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'board',     label: 'Board' },
]
// 'ccs' was the List view's id. It is kept pointing at the workspace so an old
// deep link, or a saved reminder, still lands on the record instead of nowhere.
const CHILD_TO_VIEW = { 'ccs-v2': 'workspace', 'ccs': 'workspace', 'ccs-kanban': 'board' }

const VIEW_IDS = new Set(VIEWS.map(v => v.id))

export default function ProjectsWorkspace({ navTarget, onClearNav, onRecordSelect, onNavigateApp }) {
  // Anyone whose last session ended on the List view has 'list' in
  // localStorage. Without this they would open CCS to an empty pane with no
  // way back, since the button that set it no longer exists.
  const saved = localStorage.getItem('projects_view')
  const initial = VIEW_IDS.has(saved) ? saved : 'workspace'
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
      go(VIEW_IDS.has(navTarget.view) ? navTarget.view : 'workspace')
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
        <span className="pw-title">CCS</span>
        <div className="pw-views">
          {VIEWS.map(vw => (
            <button key={vw.id} className={`pw-view${view === vw.id ? ' active' : ''}`} onClick={() => go(vw.id)}>{vw.label}</button>
          ))}
        </div>
      </div>
      <div className="pw-body">
        {visited.has('workspace') && <div style={{ display: view === 'workspace' ? 'contents' : 'none' }}><CCSv2 navTarget={childNav} onNavigateTo={handleChildNav} onNavigateApp={onNavigateApp} onClearNav={clearChildNav} onRecordSelect={onRecordSelect} /></div>}
        {visited.has('board') && <div style={{ display: view === 'board' ? 'contents' : 'none' }}><CCSKanban navTarget={childNav} onNavigateTo={handleChildNav} onClearNav={clearChildNav} /></div>}
      </div>
    </div>
  )
}
