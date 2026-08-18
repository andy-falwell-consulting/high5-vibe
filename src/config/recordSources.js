import { RCD_CACHE_VERSION } from './ccsCache'
import { listPeople, listOrganizations } from '../api/vibeContacts'

// Cross-module record sources — read from the already-prewarmed caches.
// Shared by CommandPalette (⌘K search) and RecordPicker (reminder linking),
// so the type→color/label mapping only lives in one place.
//
// `cv` MUST match the module's own CACHE_VERSION (and App.jsx's prewarm entry)
// for that layout. Reading a version nobody wrote finds an empty cache, so the
// type silently vanishes from search with no error — Products sat on a stale
// cv: 4 against an actual 5 and never appeared in ⌘K at all. When you bump a
// module's CACHE_VERSION, bump it here too.
// A source normally reads a prewarmed FileMaker cache, named by `layout` + `cv`.
// A source with its own `load()` reads from somewhere else instead — that is how
// Vibe's contact model gets into search, since it has no FileMaker cache to read
// (PHASE B5).
//
// `load()` returns records already in `{ recordId, fieldData }` shape so
// everything downstream — CommandPalette, RecordPicker — stays identical.
export const RECORD_SOURCES = [
  // Contacts, from VIBE's own model.
  //
  // Measured 2026-08-18: searching for a person or organization that exists only
  // in Vibe found NOTHING, while a FileMaker contact was found — so every
  // contact created in Contacts v2 since it shipped (2026-08-06) has been
  // invisible to ⌘K, and creating one today produced a contact nobody could
  // find. The old entry read the `Contacts_New` FileMaker replica, which of
  // course has no row for them.
  //
  // These come FIRST so their results outrank the legacy source below.
  { module: 'contacts-v2', kind: 'organization', type: 'Contact', icon: '◎', color: '#8b5cf6',
    load: () => listOrganizations().then(rows => rows.map(o => ({
      recordId: o.id,
      fieldData: { name: o.name, sub: [o.type, ...(o.phones || []), ...(o.emails || [])].filter(Boolean).join(' · ') },
    }))),
    title: f => f.name, sub: f => f.sub },
  { module: 'contacts-v2', kind: 'person', type: 'Contact', icon: '◉', color: '#8b5cf6',
    load: () => listPeople().then(rows => rows.map(p => ({
      recordId: p.id,
      fieldData: { name: p.name, sub: [p.title, ...(p.phones || []), ...(p.emails || [])].filter(Boolean).join(' · ') },
    }))),
    title: f => f.name, sub: f => f.sub },

  // The legacy FileMaker contacts, kept as a FALLBACK rather than deleted.
  //
  // Both stores are populated in production and cover the same people, so
  // showing both would list most contacts twice. This one is therefore SKIPPED
  // whenever the Vibe sources returned anything (see `usableSources`). It still
  // matters where Vibe's contact model has no data — Dev, which by decision is
  // never being populated — and it goes away with the legacy module in B4.
  { module: 'contacts', layout: 'Contacts_New', cv: 2, type: 'Contact', icon: '◉', color: '#8b5cf6',
    legacyContactsFallback: true,
    title: f => f.zz__Display__ct, sub: f => f['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || f.Type || '' },
  { module: 'inspections', layout: 'Inspections_New', cv: 1, type: 'Inspection', icon: '⚑', color: '#3b82f6',
    title: f => f.Organization || f['inspt_CNTCT__site::Name_Organization'],
    sub: f => [f['inspt_CNTCT__site::Site Number'], f.Date].filter(Boolean).join(' · ') },
  { module: 'projects', layout: 'RCD_New', cv: RCD_CACHE_VERSION, type: 'Project', icon: '◈', color: '#e8722a',
    title: f => f.zz__Display_Organization__ct,
    sub: f => [f['Type of Project(1)'], f.kanban_status].filter(Boolean).join(' · ') },
  { module: 'products', layout: 'Products & Services_New', cv: 5, type: 'Product', icon: '◫', color: '#d97706',
    title: f => f.Name, sub: f => f.SKU || f.Category || '' },
  { module: 'estimates', layout: 'Estimates_New', cv: 2, type: 'Estimate', icon: '▤', color: '#10b981',
    title: f => f.zz__Display_Contact__ct || f.Title, sub: f => f.Title !== (f.zz__Display_Contact__ct || f.Title) ? f.Title : '' },
  { module: 'rmi', layout: 'RMI_New', cv: 1, type: 'RMI', icon: '⚠', color: '#f43f5e',
    title: f => f.zz__Display_Organization__ct || f.zz__Display_Contact__ct,
    sub: f => f.Level_of_Risk || '' },
  { module: 'trainings', layout: 'trainings_New', cv: 1, type: 'Training', icon: '◆', color: '#0ea5e9',
    title: f => f.zz__Display_Organization__ct, sub: f => f['Type of Program'] || '' },
  { module: 'oe-lookup', layout: 'OELookup_New', cv: 1, type: 'OE Lookup', icon: '⌕', color: '#a3a3a3',
    title: f => f['Program Type'], sub: f => f['Program Code'] || '' },
]

// FIRST entry wins per module, not last. Two sources share the `contacts-v2`
// module (organizations and people are searched separately but open the same
// page), and Object.fromEntries would otherwise silently keep whichever happened
// to be listed second. Both carry the same type and colour, so a reminder's pill
// reads the same either way — but relying on list order for that would be a trap
// waiting for someone to reorder the array.
const BY_MODULE = {}
for (const s of RECORD_SOURCES) if (!(s.module in BY_MODULE)) BY_MODULE[s.module] = s

// The sources actually worth reading, given what came back.
//
// The legacy FileMaker contacts source is dropped whenever Vibe's own contact
// model returned anything, because both stores hold the same people and showing
// both lists most contacts twice. Where Vibe has no data — Dev, which by
// decision is never being populated — it stays, so contact search still works
// there. See the note on the sources themselves.
export function usableSources(datasetFor) {
  const vibeHasContacts = RECORD_SOURCES
    .filter(s => s.module === 'contacts-v2')
    .some(s => (datasetFor(s) || []).length > 0)
  return RECORD_SOURCES.filter(s => !(s.legacyContactsFallback && vibeHasContacts))
}

// Best-effort type/color lookup for a stored recordType — used to render a
// colored pill for a reminder's linked record without re-fetching the source.
export function recordSourceFor(moduleId) {
  return BY_MODULE[moduleId] || null
}
