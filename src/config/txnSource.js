// How a transaction's source is LABELLED and COLOURED on screen.
//
// The codes are the contract — `api/_txnSource.js` decides them, this decides
// what they look like. The label strings are deliberately duplicated here rather
// than sent down with all 34,452 rows: shipping "Challenge Course Services" on
// every row costs ~1 MB a page load to repeat eight strings the client can hold
// once. If a code ever appears here that the server does not produce, or the
// reverse, the fallback below shows the raw code rather than a blank.

// Categories, from the system's category tokens — which exclude red by design,
// so nothing here can compete with the brand accent.
export const LINE_META = {
  ccs:         { label: 'Challenge Course', short: 'CCS',      tone: 'blue' },
  training:    { label: 'Training & TD',    short: 'Training', tone: 'green' },
  catalog:     { label: 'Catalog',          short: 'Catalog',  tone: 'purple' },
  rcd:         { label: 'RCD Components',   short: 'RCD',      tone: 'khaki' },
  fundraising: { label: 'Fundraising',      short: 'Giving',   tone: 'gold' },
  deposit:     { label: 'Deposit',          short: 'Deposit',  tone: 'neutral' },
  shipping:    { label: 'Shipping',         short: 'Ship',     tone: 'neutral' },
  travel:      { label: 'Travel',           short: 'Travel',   tone: 'mustard' },
};

export const ORIGIN_META = {
  vibe:       { label: 'Created in Vibe',     short: 'Vibe' },
  estimate:   { label: 'From an estimate',    short: 'Estimate' },
  self:       { label: 'Where work started',  short: '' },     // an estimate; no row chip
  shopify:    { label: 'Shopify order',       short: 'Shopify' },
  amazon:     { label: 'Amazon',              short: 'Amazon' },
  paypal:     { label: 'PayPal',              short: 'PayPal' },
  bloomerang: { label: 'Bloomerang donation', short: 'Giving' },
  unknown:    { label: 'No source recorded',  short: '—' },
};

export const lineLabel = code => LINE_META[code]?.label || code || null;
export const lineShort = code => LINE_META[code]?.short || code || null;
export const lineTone = code => LINE_META[code]?.tone || 'neutral';
export const originLabel = kind => ORIGIN_META[kind]?.label || kind || null;
export const originShort = kind => ORIGIN_META[kind]?.short ?? kind;

// The order filters offer, most common first — measured over the ledger, so the
// choices a person reaches for are at the top rather than in alphabetical order.
export const LINE_ORDER = ['catalog', 'ccs', 'training', 'deposit', 'fundraising', 'shipping', 'rcd', 'travel'];
export const ORIGIN_ORDER = ['self', 'shopify', 'estimate', 'amazon', 'bloomerang', 'paypal', 'vibe', 'unknown'];
