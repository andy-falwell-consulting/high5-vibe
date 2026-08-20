# Brand reference

What the High 5 brand actually requires, and what this system invented on top of it.

The distinction runs through the whole document, because it decides what you may
change. A **brand standard** comes from the style sheet and is not yours to alter. A
**house convention** was invented here because a UI needs it and the brand does not
publish it — those are open to argument, and saying so is what stops them hardening
into false authority.

---

## Provenance

| Source | Covers |
|---|---|
| High 5 Adventure Learning Center style sheet (PDF, received 2026-07-20) | Colour, logo rules, typefaces |
| `brand.json` | That sheet, transcribed. Every value carries a `provenance` field |
| `palette.json` | Derived from `brand.json` by `tokens/derive_palette.py`. Not hand-edited |
| `tokens/` | Derived from `palette.json` by `tokens/generate.py`. Not hand-edited |

The style sheet publishes colour, logo rules and typefaces. It publishes **no**
gradations, spacing, radius, shadow, elevation, numeric type scale, line-height,
letter-spacing, duration, easing or z-index. Everything of that kind here is a house
convention.

---

## Colour

### The seven brand colours

These are the style sheet's, verbatim. Each is the **anchor** of a twelve-step ramp
and appears unchanged at its own step.

| Colour | Hex | Pantone | Anchor step |
|---|---|---|---|
| **Red** | `#ED1C24` | Pantone Red | `red/700` |
| Gold | `#ED8B00` | PMS 144 | `gold/600` |
| Blue | `#009CDE` | PMS 2925 | `blue/600` |
| Mustard | `#DAAA00` | PMS 110 | `mustard/500` |
| Khaki | `#C6B784` | PMS 466 | `khaki/500` |
| Purple | `#92368D` | PMS 513 | `purple/800` |
| Black | `#000000` | — | `grey/1100` |

### The ramps are a house convention

The style sheet gives seven flat colours. A UI needs tints for surfaces and shades for
text, so `tokens/derive_palette.py` builds twelve gradations around each anchor by
interpolating in CIELAB to a fixed lightness curve, tapering chroma toward both ends.

sRGB interpolation was rejected: it darkens and dulls mid-tones, because sRGB is not
perceptually uniform. That is the muddy-ramp effect you get from mixing a hex toward
white in a spreadsheet.

**No brand colour is altered by this** — the anchor step is the style-sheet hex,
untouched. Every other value is derived and is ours.

### Two hues the brand does not have

**Grey**, derived from the brand black, so the neutral carries the same cast as the
logo box rather than an arbitrary grey.

**Green** (`#22C55E`), for success. The brand has no green, and encoding success in
one of the six brand hues would collide with category colour. This matches the value
already in `src/config/brandColors.js`, which made the same call independently.

Both are house conventions.

---

## The red

### One red, two jobs

The palette has exactly one red, and it has to be both the **brand accent** and the
**error colour**. Most systems separate these — the one this is modelled on has a
distinct brand hue and error hue — and High 5 does not have that luxury.

What keeps the two signals apart is the accent policy below: red as accent is
non-text chrome (a focus ring, an indicator, the logo), and red as error is a label
or a tinted surface with a message on it. They rarely appear together, and when they
do the error is the one with words in it.

### The red cannot carry a label

**This is the single most load-bearing measurement in the system.**

| | On white |
|---|---|
| `red/600` `#F9463B` | 3.52:1 — fails |
| **`red/700` `#ED1C24` — the brand hex** | **4.38:1 — fails AA** |
| `red/800` `#AE000D` | 7.49:1 — passes |
| `red/900` `#8F0000` | 9.69:1 — passes |

White text on the brand red is **4.38:1**, and WCAG AA needs 4.5:1. It misses.

So a destructive button is **not** filled with the brand red. `--error-solid`
resolves to `red/800`, and the brand hex stays where it is legible and non-text: the
focus ring, the active indicator, the logo.

A consequence worth noticing: the destructive button's **hover goes darker**, which
is the opposite of the usual instinct. Every step light enough to read as "more
prominent" fails the label contrast.

### Accent policy

> Red is reserved for accents and key highlights. Quality over quantity.

**Sanctioned**

- The High 5 logo mark
- The focus ring (`--focus-ring`)
- The active tab / nav indicator
- The selected row's left border in a list — it marks position rather than
  decorating a message, and the surface change carries the state on its own for
  anyone who cannot see the colour
- A destructive action's solid fill (`--error-solid`), where red carries meaning
  rather than decoration — and at the darker step, per above

**Prohibited**

- Red backgrounds behind UI text, other than the sanctioned destructive fill
- The logo on any red surface — the style sheet says plainly that it does not work
- Left-edge accent stripes on callouts. This is the most common way an accent leaks
  into chrome, and the tinted background already carries the status
- Red as a **category colour**. It is the accent, and a category palette containing
  it cannot also signal "this one matters". `CAT_HUES` excludes it
- Red on text below 24px that is not a destructive label, where it fails AA

### Category colour

Six hues, red excluded: blue, purple, gold, mustard, khaki, green.

Each has three tokens, and the third is not redundant:

- `--cat-<hue>-bg` + `--cat-<hue>-fg` — a tinted surface with text on it
- `--cat-<hue>-solid` — a **filled mark with no text**: a legend swatch, a status
  dot, a chart series

`-fg` cannot do the `-solid` job in dark mode, where every hue's `/400` is a pale
tint and six categories would render as six similar pale dots. `-solid` is tested at
WCAG 1.4.11's 3:1 for non-text graphics rather than the 4.5:1 text minimum.

---

## Typography

| Role | Face | Provenance |
|---|---|---|
| Body | Myriad Pro | style sheet |
| Titles | Berthold Imago | style sheet |
| Quotes | Kremlin Pro | style sheet |
| **Numbers only** | Bernhardt Standard | style sheet |

All four are **commercial and licensed**. They cannot be bundled as webfonts without
the licence files, so every token names the brand face first and falls back. Install
the licensed faces locally and the real thing is picked up with no code change.

The fallback stacks are house conventions, chosen for **shape** rather than
popularity: Optima and Candara are humanist sans faces close to Berthold Imago;
Georgia is a transitional serif close to Kremlin Pro.

The style sheet is explicit that Bernhardt Standard is for numbers only. It gets a
class (`.h5-num`) rather than a global rule, which is what stops it being applied to
a heading by someone who liked the look of it.

### Scale

House convention — the style sheet publishes no type scale.

Pair a headline with subcopy 30–60% smaller. Within body copy use a smaller shift,
around 10–15%, or the two sizes read as unrelated rather than as a hierarchy.

---

## Logo

`src/assets/high5-logo.png` (516×918). Rules from the style sheet:

- **Use it intact.** Never recreate, crop, recolour, or separate the mark from the
  band.
- **Never on red.** The app accent is red, so the logo sits on white or black.
- **Upper-left** placement.
- The lower `ADVENTURE LEARNING CENTER` band is **black-on-white**, so on the dark
  theme the logo needs a white card behind it or that text disappears.

---

## Accessibility

Every colour pairing a component relies on is declared in `CONTRAST` in
`tokens/generate.py` and measured in **both themes before the tokens are written**.
A palette that cannot carry legible text is a design failure, so the generator
refuses to emit one rather than reporting on it afterwards.

- Text meets WCAG AA (4.5:1).
- Non-text graphics — focus rings, interactive borders, category marks — meet
  WCAG 1.4.11 (3:1).
- Disabled text is exempt under WCAG 1.4.3 and is the only pairing not held to a
  minimum.

Colour is never the only carrier of meaning. An invalid field gets a message bound
with `aria-describedby`, not just a red border; a selected list row changes surface,
not just its border colour.

---

## Known tensions

Recorded rather than hidden, because each is a place where the brand and a working
UI genuinely pull against each other.

**One red for accent and error.** Handled by policy, not by palette. If the brand
ever publishes a second red, `--error-*` should move to it.

**The brand red fails AA for labels.** So the destructive fill is a derived step, and
the most recognisable colour in the brand is the one you may use least.

**Four licensed faces, none bundleable.** Until the licences are installed, the app
renders in fallbacks — which means the typography you see is not yet the typography
the brand specifies.

**Twelve gradations from one flat colour.** The ramps are reproducible and
perceptually sound, but they are an interpretation. If High 5 ever publishes official
tints, `derive_palette.py` should be replaced by that file, not adjusted to match it.
