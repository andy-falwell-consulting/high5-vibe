// Fields carried over when copying a previous inspection: the site's course
// profile (course types + equipment) and address — NOT the old inspection's
// findings/status (Report Ready, needs_repair) or its QBO invoice/estimate
// links, which belong to that year's inspection.
//
// Shared by both copy entry points (the Inspections module's ＋New and
// QuickAddFromContact) so they can't drift apart.
export const INSPECTION_COPY_FIELDS = [
  'Address_Block_Billing', 'ALF', 'Organization',
  'fa_Leads_and_Y_Lanyards', 'fa_Rope_Grabs', 'fa_Cable_Grab', 'fa_Prusik',
  'fa_Belay_Extra_P_Cord', 'fa_Stairs_Ladder', 'fa_other',
  'ct_Low', 'ct_High', 'ct_Trees', 'ct_Poles', 'ct_Indoors', 'ct_Dynamic',
  'ct_Static_Voyageur_Style', 'ct_Auto_Belay', 'ct_Other',
];

// Value lists as defined on the Inspections_New layout. CATEGORIES is also the
// canonical report order — History first, Repairs last. Both the on-screen line
// editor and the PDF report group by it, so what you see is what prints.
export const CATEGORIES = ['History', 'General Comments', 'Equipment', 'Low Element', 'High Element', 'Addendum', 'Repairs'];
export const ELEMENT_GRADES = ['5', '4', '3', '2', '1', 'NI'];
export const EQUIPMENT = ['ropes', 'harnesses', 'helmets', 'carabiners', 'belay devices', 'pulleys', 'misc.'];

// Rank a category for sorting. Anything not on the value list (historical
// drift) sorts after the known ones rather than being dropped or reordered.
export const categoryRank = c => {
  const i = CATEGORIES.indexOf(c);
  return i === -1 ? CATEGORIES.length : i;
};

/** Pick the copyable profile fields out of a source inspection's fieldData. */
export function copyProfileFields(sourceFieldData = {}) {
  const out = {};
  for (const k of INSPECTION_COPY_FIELDS) {
    const v = sourceFieldData[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}
