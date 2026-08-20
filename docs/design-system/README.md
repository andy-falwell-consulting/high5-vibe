# High 5 design system

The brand rules that apply to Vibe, the tokens that encode them, and the components
that consume them.

**Reference only for now.** Nothing in `src/` imports this yet. It exists so that
when Vibe is brought onto it, there is one answer to what a colour, a size or a
component should be — rather than the current situation, where each module carries
its own hardcoded hexes and its own idea of a card.

## Start here

| File | What it's for |
|---|---|
| [`BRAND.md`](BRAND.md) | What the High 5 brand actually requires, with provenance. Says plainly which parts are brand standards and which are house conventions. |
| [`COMPONENTS.md`](COMPONENTS.md) | The catalogue: variants, markup, do/don't for all 15 components. |
| [`preview/index.html`](preview/index.html) | Every component and variant, both themes. The visual proof. |
| [`brand.json`](brand.json) | The style sheet, transcribed. **The source of truth.** |
| [`palette.json`](palette.json) | 8 hues × 12 gradations, derived from `brand.json`. |
| [`tokens/`](tokens/) | `tokens.css` (what you import), `tokens.json` (machine-readable mirror), and the two scripts that generate both. |
| [`components/`](components/) | 15 stylesheets plus a barrel. |

## See it

```bash
cd docs/design-system && python3 -m http.server 8901
```

Then open `http://localhost:8901/preview/index.html` and use **Toggle theme**.

## Regenerate

```bash
cd docs/design-system
python3 tokens/derive_palette.py   # brand.json  -> palette.json
python3 tokens/generate.py         # palette.json -> tokens.css + tokens.json
```

Stdlib only, no install step — a tool that needs setting up is a tool that does not
get run.

`generate.py` **refuses to write** if any declared colour pairing falls below its
contrast minimum in either theme. A palette that cannot carry legible text is a
design failure, so it should be impossible to emit one rather than something caught
later. That check is what found the one real constraint the brand imposes: white on
the brand red is 4.38:1 and fails AA, so the destructive fill had to move to a darker
step.

## How it's put together

Three layers. The discipline is that each layer only talks to the one above it.

```
brand.json          the style sheet, transcribed. 7 colours, 4 faces, logo rules.
      |             BRAND STANDARD — not ours to change.
      v
palette.json        8 hues x 12 gradations. Anchors are the brand hexes, unchanged;
      |             every other step is derived in CIELAB. HOUSE CONVENTION.
      v
tokens/tokens.css   Layer 1 primitives  --h5-red-700
      |             Layer 2 semantic    --fg, --error-bg     <- components use these
      |             Layer 3 scales      --space-lg, --radius-md
      v
components/         15 stylesheets. Semantic tokens only.
```

**A component never reaches past Layer 2.** No primitive, no hex. That is what makes
the theme switch work and what would let the palette change without touching a
component.

## Using it

```css
@import url('./tokens/tokens.css');
@import url('./components/_index.css');
```

Then `class="h5-btn h5-btn--primary"` rather than a bespoke `.trn-save-btn`.

## What this deliberately is not

No PR checklist, no violation audit, no CI test suite. This is a design reference —
what things should look like and why — not a process. The one check that survived is
the contrast gate inside the generator, and it is there because it prevents an
unreadable palette rather than because it polices anyone.

## Adopting it in Vibe

Not started, and worth doing in this order when it is:

1. Import the tokens alongside the existing `:root`, changing nothing else. The two
   coexist.
2. Move one module — Contacts is the biggest, OE Trainings the newest and smallest —
   onto the component classes.
3. Delete that module's stylesheet.
4. Repeat, and remove Vibe's own `:root` once nothing reads it.

Vibe currently defines its dark palette **twice** — once in a `[data-theme]` block and
again in a `prefers-color-scheme` media query. This system has exactly one dark block
on purpose, because two is a guaranteed drift source. Reconciling that is part of
step 1.
