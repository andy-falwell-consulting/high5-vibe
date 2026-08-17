import { RCD_CACHE_VERSION } from './ccsCache';

// What work a contact has: the records that used to arrive as FileMaker portals
// on Contacts_New, sourced instead from each module's own cache.
//
// WHY NOT PORTALS. Vibe overlays are per-layout and cover fieldData only —
// api/record.js preserves portalData untouched. So a portal on Contacts_New
// cannot see a Vibe edit to Inspections_New or RCD_New, and the old Contacts
// page has been showing stale CCS status since RCD went Vibe-owned, and stale
// inspection dates since v1.0.328. Reading the module caches instead means
// these lists go through the overlay and are correct by construction.
//
// HOW THE JOIN WORKS. Measured against production on 2026-08-17, not assumed —
// the field that looks like the obvious key is often not the one that is
// populated:
//
//   layout            _kft__Contact_ID     organization name
//   Inspections_New   85/200  (42%)        200/200
//   RCD_New           196/200              198/200
//   trainings_New     197/200              198/200
//   RMI_New           103/117              115/117
//   Estimates_New     NOT ON THE LAYOUT    display calc only
//
// Inspections is the reason `org` is not a fallback but a first-class key: an
// inspection hangs off a *site* contact rather than the organization a picker
// returns (the join trap in CLAUDE.md), and its FK is empty more often than
// not. Matching on organization name is what the inspt_CNTCT__site
// relationship keys on anyway, and it is what Inspections.jsx already does.
//
// IS MATCHING ON A NAME SAFE? Across 4,751 organizations there are 4,726
// distinct names: 19 names are shared, covering 39 organizations (0.8%). Those
// are reported to the reader rather than silently merged — see sharedName in
// useRelatedRecords.
//
// cv MUST match the module's own CACHE_VERSION. Reading a version nobody wrote
// finds an empty cache and the section renders empty with no error — the same
// trap documented in recordSources.js, which cost Products its ⌘K entry.
export const RELATED_SOURCES = [
  {
    id: 'inspections',
    label: 'Inspections',
    module: 'inspections',
    layout: 'Inspections_New',
    cv: 1,
    fk: '_kft__Contact_ID',
    org: f => f.Organization || f['inspt_CNTCT__site::Name_Organization'],
    date: f => f.Date,
    columns: [
      { label: 'Date', get: f => f.Date },
      { label: 'Site', get: f => f.Organization || f['inspt_CNTCT__site::Name_Organization'] },
      { label: 'Inspector', get: f => f['Inspectors Name'] },
    ],
  },
  {
    id: 'ccs',
    label: 'CCS projects',
    module: 'projects',
    layout: 'RCD_New',
    cv: RCD_CACHE_VERSION,
    fk: '_kft__Contact_ID',
    org: f => f.zz__Display_Organization__ct,
    date: f => f['rcd start date'],
    columns: [
      { label: 'Start', get: f => f['rcd start date'] },
      { label: 'Organization', get: f => f.zz__Display_Organization__ct },
      { label: 'Type', get: f => f['Type of Project(1)'] || f.zz__TypeOfProjectList__ct },
      { label: 'Status', get: f => f.kanban_status || f.Status },
    ],
  },
  {
    id: 'trainings',
    label: 'Custom training',
    module: 'trainings',
    layout: 'trainings_New',
    cv: 1,
    fk: '_kft__Contact_ID',
    org: f => f.zz__Display_Organization__ct,
    date: f => f['Start Date'],
    columns: [
      { label: 'Start', get: f => f['Start Date'] },
      { label: 'Organization', get: f => f.zz__Display_Organization__ct },
      { label: 'Type', get: f => f['Type of Program'] },
      { label: 'Status', get: f => f.Status },
    ],
  },
  {
    id: 'estimates',
    label: 'Estimates',
    module: 'estimates',
    layout: 'Estimates_New',
    cv: 1,
    // _kft__Contact_ID was added to this layout on 2026-08-17 so estimates could
    // join the same way everything else does. Records written before then still
    // resolve through `org` on the display calc, which is populated on 2,808 of
    // 2,817 estimates — the 9 exceptions read "<deleted>" and belong to a
    // contact that no longer exists.
    fk: '_kft__Contact_ID',
    org: f => f.zz__Display_Contact__ct,
    date: f => f.Date,
    columns: [
      { label: 'Date', get: f => f.Date },
      { label: 'Title', get: f => f.Title },
      { label: 'Total', get: f => f.zz__Total__xn, money: true },
      { label: 'Status', get: f => f.Status },
    ],
  },
  {
    id: 'rmi',
    label: 'Risk items',
    module: 'rmi',
    layout: 'RMI_New',
    cv: 1,
    fk: '_kft__Contact_ID',
    org: f => f.zz__Display_Organization__ct || f.zz__Display_Contact__ct,
    date: f => f.Date,
    columns: [
      { label: 'Date', get: f => f.Date },
      { label: 'Organization', get: f => f.zz__Display_Organization__ct || f.zz__Display_Contact__ct },
      { label: 'Risk', get: f => f.Level_of_Risk },
      { label: 'Assigned', get: f => f.Assigned_To },
    ],
  },
];

// A contact created in Vibe has no FileMaker history to find. Its id is minted
// with a V-/VA- prefix (api/_contacts.js), where a migrated contact's id IS
// FileMaker's _kpt__Contact_ID — which is what makes this join possible at all.
export const isVibeMintedId = id => /^V[A]?-/.test(String(id ?? ''));
