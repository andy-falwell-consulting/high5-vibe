# Component catalogue

Fifteen stylesheets. Every rule consumes semantic tokens (`--fg`, `--space-lg`) and
never a primitive (`--h5-red-700`) or a raw hex — that indirection is what lets the
theme switch and the palette change without touching a component.

See them all in both themes: open `preview/index.html`.

```css
@import url('./tokens/tokens.css');      /* first — everything below resolves against it */
@import url('./components/_index.css');
```

---

## Layout

The module shell: sidebar list, resize handle, detail pane. **The scrolling rules are
the point of this file** — they are unintuitive, they cause the two most-repeated
layout bugs in Vibe, and neither is discoverable from reading working markup.

```html
<div class="h5-module">
  <aside class="h5-sidebar" style="width:320px">
    <div class="h5-sidebar__head">…toolbar…</div>
    <div class="h5-sidebar__list h5-scroll">…rows…</div>
  </aside>
  <div class="h5-resize"></div>
  <main class="h5-detail">
    <div class="h5-page-header">…</div>
    <div class="h5-detail__body h5-scroll">…sections…</div>
  </main>
</div>
```

**Do**

- `flex: 1; min-height: 0` on the module root. A module mounts under a
  `display: contents` wrapper, so its root is a direct flex child of the app root.
- `min-height: 0` on anything that scrolls. A flex item will not shrink below its
  content without it, so the container never becomes short enough for
  `overflow-y: auto` to fire.
- `flex-shrink: 0` on every direct child of a scrolling column. `.h5-detail__body > *`
  does this for you.
- Give the list its own scroller. A list helper that returns a bare array has no
  wrapper of its own.

**Don't**

- `height: 100%` on a module root. It collapses under `display: contents` and leaves
  the page unfilled.
- Rely on the sidebar's `overflow: hidden` to produce scrolling. It produces
  clipping — the rows exist, and there is no way to reach them.

---

## Typography

`.h5-display` `.h5-h1` `.h5-h2` `.h5-h3` `.h5-body-lg` `.h5-body` `.h5-caption`
`.h5-micro` `.h5-quote` `.h5-num` `.h5-muted` `.h5-mono`

**Do** pair a headline with subcopy 30–60% smaller; use `.h5-num` for figures so
columns align.

**Don't** use `.h5-quote` (Kremlin Pro) for anything but a pull quote, or `.h5-num`
(Bernhardt Standard) for anything but numerals. The style sheet is explicit on both.

---

## Button

`.h5-btn` + `--primary` `--secondary` `--ghost` `--danger` `--danger-subtle` `--sm`

```html
<button class="h5-btn h5-btn--primary">Save</button>
<button class="h5-btn h5-btn--danger">Delete</button>
```

**Do** use `--danger-subtle` as the resting half of an arm/confirm pair, and
`--danger` only once the action is armed.

**Don't** fill a button with the brand red. `--error-solid` is `red/800` because
white on `#ED1C24` is 4.38:1 and fails AA. Note the hover goes **darker** — every
lighter step fails the label.

---

## Chip

`.h5-chip` + `--selected`, with `.h5-chip__count`.

**Do** declare selected state after hover — it already is, which is why no
specificity hack is needed.

**Don't** make the selected chip red. Selection is a neutral fill; a row of six
selected red chips says nothing about which one matters.

---

## Badge & dot

`.h5-badge` + status (`--error` `--success` `--warning` `--info`) or category
(`--blue` `--purple` `--gold` `--mustard` `--khaki` `--green`).

`.h5-dot` + the same category modifiers, for a filled mark with no text.

**Do** use `.h5-dot` for legend swatches and status dots — it resolves to
`-solid`, which stays distinguishable in dark mode.

**Don't** use a badge's `-fg` colour for a dot. In dark mode every hue's `/400` is a
pale tint, so six categories become six similar pale dots.

---

## Card

`.h5-card` + `--flush` (no padding, for a table or list) `--raised`, with
`.h5-card__head` and `.h5-card__title`.

**Do** use `--card` / `--card-border`, which is what the class already does: in dark
mode a card sits on `--bg` and needs to be lighter than it.

---

## Field

`.h5-field` + `--invalid`, with `__label` `__control` `__hint` `__error`.

```html
<div class="h5-field h5-field--invalid">
  <label class="h5-field__label" for="code">Course code</label>
  <input class="h5-field__control" id="code" aria-describedby="code-err">
  <span class="h5-field__error" id="code-err">Needs a year and a sequence.</span>
</div>
```

**Do** bind the error with `aria-describedby`.

**Don't** signal invalidity with the red border alone — colour cannot be the only
carrier of meaning.

---

## Tabs

`.h5-tabs` / `.h5-tab` + `--active` — underline form, one of the sanctioned accent
uses. The indicator is a non-text graphic (3:1 applies) and the label carries the
state in weight as well.

`.h5-segmented` / `.h5-segment` + `--active` — segmented control.

**Note — this component differs in kind between themes, deliberately.** Light raises a
white pill onto a grey track. Dark cannot: `--surface`, `--card` and the track are all
`grey/1000`, so a `--card` pill would be invisible against its own track. Dark makes
the indicator a light **fill** and inverts the label with it.

---

## Table

`.h5-table-wrap` > `.h5-table`, with `.h5-table__num` for figures.

**Do** keep the wrapper. A wide table scrolls inside its own container.

**Don't** let a table make the page scroll sideways — that is a layout bug, not a
table feature.

---

## Callout

`.h5-callout` + `--error` `--success` `--warning` `--info`, with `__icon` `__title`
`__body`.

**Don't** add a left-edge accent stripe. It is the most common way an accent leaks
into chrome, and the tinted background already carries the status.

---

## Modal

`.h5-scrim` > `.h5-modal`, with `__head` `__title` `__body` `__foot`.

**Do** let `__body` scroll and keep head and foot pinned — they already are.

---

## List

`.h5-list-item` + `--active`, with `__body` `__title` `__sub` `__count`, and
`.h5-list-letter` for A–Z headers.

The active row uses a **left border in the accent**. This is the one place a
left-edge accent is right: it marks position in a list rather than decorating a
message, and the surface change carries the state on its own.

---

## Page header

`.h5-page-header` with `__row` `__title` `__meta` `__actions`. Sits above
`.h5-detail__body` and stays put while the body scrolls.

---

## Empty state

`.h5-empty` + `--error`, with `__icon` `__title` `__body`.

**Do** distinguish *nothing here yet* from *nothing matched* from *something broke*.
All three render as a blank pane and need three different actions from whoever is
looking at it.

---

## Skeleton

`.h5-skeleton` + `--text` `--row`.

Honours `prefers-reduced-motion` — the shimmer is decorative, and for someone with
vestibular sensitivity a page full of moving bars is the worst kind of decoration.
