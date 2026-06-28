// Shared cache config for Course Projects — used by CCS, CCSKanban, and App prefetch.
// Reads the RCD_New layout, which is mirrored into the Redis replica (api/_replica.js)
// for fast loads. RCD_FIND_QUERY is null so the replica path is used (it serves the
// full table); recency is handled client-side by the default created-desc sort.
export const RCD_LAYOUT = 'RCD_New'
export const RCD_CACHE_VERSION = 10

export const rcdTwoYearsAgo = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 2)
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`
}

// null → getAllRecords uses the Redis replica (fetchFromReplica bails when a
// findQuery is set). Kept exported for any caller that still references it.
export const RCD_FIND_QUERY = null
export const RCD_SORT = [{ fieldName: 'zz__Created_On', sortOrder: 'descend' }]

