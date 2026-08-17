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
// HOW THE JOIN WORKS. Measured against every record in production on
// 2026-08-17, not assumed. The question asked was: when a record's organization
// NAME resolves to organization X, does its _kft__Contact_ID also point at X?
//
//   layout            FK = the org   FK points elsewhere   no FK
//   Inspections_New            0            3,862            476
//   RCD_New                    0            6,329             78
//   trainings_New              0            2,361             43
//   RMI_New                    0              103             12
//   Estimates_New          2,723               12              0
//
// Zero is not a rounding artefact. On four of the five layouts the foreign key
// NEVER names the organization — it names the *person* the work was arranged
// with, or the *site* contact it was carried out at, both of which are separate
// contact records from the organization a picker returns. That is the join trap
// in CLAUDE.md, and it is total rather than occasional. On those four, matching
// the organization name is the entire join; the id check below fires for
// people's own pages and effectively never for an organization's.
//
// Estimates is the exception, and the reason `fkIsOrg` exists. Its key names
// the organization itself on 2,723 of 2,735 resolvable records, so there the
// key is authoritative and a name match actively does harm: 12 estimates
// belonging to one "Fay School" would otherwise also be listed under the other
// organization of the same name.
//
// IS MATCHING ON A NAME SAFE? Across 4,751 organizations there are 4,726
// distinct names: 19 names are shared, covering 39 organizations (0.8%). Where
// a name is the join, that overlap is reported to the reader rather than
// silently merged — see sharedNameCount in useRelatedRecords.
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
    // _kft__Contact_ID was placed on this layout on 2026-08-17. Unlike every
    // other source here it names the organization itself, so it is trusted
    // exclusively — see fkIsOrg and the table above.
    fk: '_kft__Contact_ID',
    fkIsOrg: true,
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
