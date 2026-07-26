// High 5 brand colours for JS colour maps (rendered as inline styles). These
// mirror the --h5-* CSS tokens in index.css — kept as hex here (not var())
// because some consumers put the value in non-CSS contexts. If you change a
// brand colour, change it in BOTH places. See the [[high5-brand]] memory.
export const BRAND = {
  red: '#ED1C24',      // Pantone Red — reserved for the primary accent / "stripe"
  gold: '#ED8B00',     // PMS 144
  blue: '#009CDE',     // PMS 2925
  mustard: '#DAAA00',  // PMS 110
  khaki: '#C6B784',    // PMS 466
  purple: '#92368D',   // PMS 513
  black: '#000000',
};

// Functional UI colours — these carry meaning, not brand identity, so green and
// grey (absent from the brand palette) are kept. Warning/danger borrow brand
// tones so alerts still read as "High 5".
export const UI = {
  success: '#22c55e',
  warning: BRAND.gold,
  danger: BRAND.red,
  neutral: '#64748b',
  muted: '#94a3b8',
};

// Ordered palette for categorical maps (things that are just "different", not
// good/bad). Red is deliberately excluded — it's the accent. Base brand colours
// first, then brand-derived tints so sets larger than the palette stay legible.
export const CATEGORICAL = [
  BRAND.blue, BRAND.purple, BRAND.gold, BRAND.mustard, BRAND.khaki,
  '#4FC3E8', // light blue
  '#B968B4', // light purple
  '#C2740C', // dark gold
  '#A98F3E', // dark mustard
  '#8A7B4F', // dark khaki
];
