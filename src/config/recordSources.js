import { RCD_CACHE_VERSION } from './ccsCache'

// Cross-module record sources — read from the already-prewarmed caches.
// Shared by CommandPalette (⌘K search) and RecordPicker (reminder linking),
// so the type→color/label mapping only lives in one place.
export const RECORD_SOURCES = [
  { module: 'contacts', layout: 'Contacts_New', cv: 2, type: 'Contact', icon: '◉', color: '#8b5cf6',
    title: f => f.zz__Display__ct, sub: f => f['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || f.Type || '' },
  { module: 'inspections', layout: 'Inspections_New', cv: 1, type: 'Inspection', icon: '⚑', color: '#3b82f6',
    title: f => f.Organization || f['inspt_CNTCT__site::Name_Organization'],
    sub: f => [f['inspt_CNTCT__site::Site Number'], f.Date].filter(Boolean).join(' · ') },
  { module: 'projects', layout: 'RCD_New', cv: RCD_CACHE_VERSION, type: 'Project', icon: '◈', color: '#e8722a',
    title: f => f.zz__Display_Organization__ct,
    sub: f => [f['Type of Project(1)'], f.kanban_status].filter(Boolean).join(' · ') },
  { module: 'products', layout: 'Products & Services_New', cv: 4, type: 'Product', icon: '◫', color: '#d97706',
    title: f => f.Name, sub: f => f.SKU || f.Category || '' },
  { module: 'estimates', layout: 'Estimates_New', cv: 1, type: 'Estimate', icon: '▤', color: '#10b981',
    title: f => f.zz__Display_Contact__ct || f.Title, sub: f => f.Title !== (f.zz__Display_Contact__ct || f.Title) ? f.Title : '' },
  { module: 'rmi', layout: 'RMI_New', cv: 1, type: 'RMI', icon: '⚠', color: '#f43f5e',
    title: f => f.zz__Display_Organization__ct || f.zz__Display_Contact__ct,
    sub: f => f.Level_of_Risk || '' },
  { module: 'trainings', layout: 'trainings_New', cv: 1, type: 'Training', icon: '◆', color: '#0ea5e9',
    title: f => f.zz__Display_Organization__ct, sub: f => f['Type of Program'] || '' },
  { module: 'oe-lookup', layout: 'OELookup_New', cv: 1, type: 'OE Lookup', icon: '⌕', color: '#a3a3a3',
    title: f => f['Program Type'], sub: f => f['Program Code'] || '' },
]

const BY_MODULE = Object.fromEntries(RECORD_SOURCES.map(s => [s.module, s]))

// Best-effort type/color lookup for a stored recordType — used to render a
// colored pill for a reminder's linked record without re-fetching the source.
export function recordSourceFor(moduleId) {
  return BY_MODULE[moduleId] || null
}
