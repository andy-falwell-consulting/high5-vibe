"""Regenerate tokens.css and tokens.json from palette.json.

    python tokens/derive_palette.py    # brand.json  -> palette.json
    python tokens/generate.py          # palette.json -> tokens.css + tokens.json

palette.json is the source of truth for colour. This script derives both token files
from it, so they cannot drift apart or from the palette. tests/test_tokens.py asserts
the outputs stay in sync, which means a hand-edit that diverges from this generator
fails the suite rather than shipping quietly.

Semantic tokens are declared here as palette references ("hue/step"); every colour
pairing added below must also be added to CONTRAST so it gets contrast-tested in both
themes.
"""

import collections
import json
import os
from pathlib import Path

os.chdir(Path(__file__).resolve().parent.parent)
PALETTE = json.loads(Path("palette.json").read_text())
BRAND = json.loads(Path("brand.json").read_text())
P = PALETTE["hues"]


def hx(ref):
    h, s = ref.split("/")
    return P[h][s]["hex"]


# ---------------------------------------------------------------------------
# Layer 2 — semantic tokens. What components consume. Never a raw hex.
# ---------------------------------------------------------------------------

LIGHT = collections.OrderedDict(
    [
        ("bg", "grey/100"),
        ("surface", "grey/0"),
        ("surface-sunken", "grey/200"),
        ("card", "grey/0"),
        ("surface-selected", "grey/0"),
        ("on-surface-selected", "grey/1000"),
        ("surface-hover", "grey/200"),
        ("fg", "grey/1000"),
        ("fg-hover", "grey/1100"),
        ("fg-secondary", "grey/700"),
        ("fg-disabled", "grey/500"),
        ("fg-inverse", "grey/0"),
        ("border", "grey/300"),
        ("card-border", "grey/400"),
        ("border-interactive", "grey/600"),
        # Brand red is red/700 — the style-sheet hex itself. See BRAND.md on why it
        # never becomes a fill behind text.
        ("brand", "red/700"),
        ("brand-strong", "red/800"),
        ("focus-ring", "red/700"),
        # Error shares the brand hue, because the palette has exactly one red. The
        # accent policy is what keeps the two signals apart; see BRAND.md, "One red,
        # two jobs".
        ("error-fg", "red/800"),
        ("error-bg", "red/100"),
        ("error-border", "red/300"),
        # NOT the brand red. Measured: white on red/700 (the style-sheet hex) is
        # 4.38:1 and fails WCAG AA — the brand colour cannot carry a white label.
        # red/800 is 7.49:1. So the destructive FILL is the darker step and the
        # brand hex stays where it is legible and non-text: the focus ring, the
        # active indicator, the logo. This is the single most load-bearing
        # consequence of the palette; see BRAND.md, "The red cannot carry a label".
        ("error-solid", "red/800"),
        ("error-solid-hover", "red/900"),
        ("on-error-solid", "grey/0"),
        ("success-fg", "green/800"),
        ("success-bg", "green/100"),
        ("success-border", "green/300"),
        ("warning-fg", "gold/800"),
        ("warning-bg", "gold/100"),
        ("warning-border", "gold/300"),
        ("info-fg", "blue/800"),
        ("info-bg", "blue/100"),
        ("info-border", "blue/300"),
    ]
)

DARK = collections.OrderedDict(
    [
        ("bg", "grey/1100"),
        ("surface", "grey/1000"),
        ("surface-sunken", "grey/1100"),
        ("card", "grey/1000"),
        # Dark has no lighter surface to raise a pill onto — surface, card and the
        # track are all grey/1000 — so the selected indicator becomes a fill and the
        # label inverts with it. The one selection state that differs in KIND between
        # themes; recorded in COMPONENTS.md under Tabs.
        ("surface-selected", "grey/300"),
        ("on-surface-selected", "grey/1100"),
        ("surface-hover", "grey/900"),
        ("fg", "grey/0"),
        ("fg-hover", "grey/200"),
        ("fg-secondary", "grey/500"),
        ("fg-disabled", "grey/700"),
        ("fg-inverse", "grey/1100"),
        ("border", "grey/900"),
        ("card-border", "grey/800"),
        ("border-interactive", "grey/600"),
        # red/700 is the brand hex and holds up on a dark surface; red/600 is the
        # lighter derived step, used where the darker one would disappear.
        ("brand", "red/600"),
        ("brand-strong", "red/600"),
        ("focus-ring", "red/600"),
        ("error-fg", "red/400"),
        ("error-bg", "red/1000"),
        ("error-border", "red/900"),
        # Same measured constraint as light — see LIGHT above. Hover goes DARKER
        # rather than lighter, which is the opposite of the usual instinct: every
        # step light enough to read as "more prominent" fails the label contrast.
        ("error-solid", "red/800"),
        ("error-solid-hover", "red/900"),
        ("on-error-solid", "grey/0"),
        ("success-fg", "green/400"),
        ("success-bg", "green/1000"),
        ("success-border", "green/900"),
        ("warning-fg", "gold/400"),
        ("warning-bg", "gold/1000"),
        ("warning-border", "gold/900"),
        ("info-fg", "blue/400"),
        ("info-bg", "blue/1000"),
        ("info-border", "blue/900"),
    ]
)

# Category colours. RED IS DELIBERATELY ABSENT: it is the accent, and a category
# palette containing it cannot also signal "this one matters". Mirrors the exclusion
# already made in src/config/brandColors.js CATEGORICAL.
CAT_HUES = ["blue", "purple", "gold", "mustard", "khaki", "green"]
CATS_L = collections.OrderedDict()
CATS_D = collections.OrderedDict()
for h in CAT_HUES:
    CATS_L[f"cat-{h}-bg"] = f"{h}/100"
    CATS_L[f"cat-{h}-fg"] = f"{h}/800"
    # -solid is a filled mark rather than a tinted surface with text on it: a legend
    # swatch, a status dot, a chart series. -fg cannot do this job in dark mode —
    # hue/400 is a pale tint for every hue, so six categories become six similar pale
    # dots. Contrast-tested at the 3:1 WCAG 1.4.11 minimum for non-text graphics.
    CATS_L[f"cat-{h}-solid"] = f"{h}/700"
    CATS_D[f"cat-{h}-bg"] = f"{h}/1000"
    CATS_D[f"cat-{h}-fg"] = f"{h}/400"
    CATS_D[f"cat-{h}-solid"] = f"{h}/600"
CATS_L["cat-neutral-bg"] = "grey/200"
CATS_L["cat-neutral-fg"] = "grey/1000"
CATS_L["cat-neutral-solid"] = "grey/700"
CATS_D["cat-neutral-bg"] = "grey/900"
CATS_D["cat-neutral-fg"] = "grey/0"
CATS_D["cat-neutral-solid"] = "grey/500"

# ---------------------------------------------------------------------------
# Layer 3 — scales. EVERY ONE OF THESE IS A HOUSE CONVENTION. The High 5 style
# sheet publishes colour, logo rules and typefaces, and nothing else.
# ---------------------------------------------------------------------------

FONT_SANS = (
    "'Myriad Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', "
    "Roboto, Helvetica, Arial, sans-serif"
)
FONT_TITLE = "'Berthold Imago', 'Myriad Pro', Optima, Candara, 'Segoe UI', sans-serif"
FONT_QUOTE = "'Kremlin Pro', Georgia, 'Times New Roman', serif"
FONT_NUM = "'Bernhardt Standard', 'Myriad Pro', Georgia, serif"
FONT_MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"

SCALES = collections.OrderedDict(
    [
        (
            "space",
            collections.OrderedDict(
                [
                    ("space-xs", "4px"),
                    ("space-sm", "8px"),
                    ("space-md", "12px"),
                    ("space-lg", "16px"),
                    ("space-xl", "20px"),
                    ("space-2xl", "24px"),
                    ("space-3xl", "32px"),
                    ("space-4xl", "48px"),
                ]
            ),
        ),
        (
            "radius",
            collections.OrderedDict(
                [
                    ("radius-xs", "4px"),
                    ("radius-sm", "6px"),
                    ("radius-md", "8px"),
                    ("radius-lg", "12px"),
                    ("radius-pill", "999px"),
                    ("radius-circle", "50%"),
                ]
            ),
        ),
        (
            "shadow",
            collections.OrderedDict(
                [
                    ("shadow-sm", "0 1px 3px rgba(0, 0, 0, 0.08)"),
                    ("shadow-md", "0 2px 16px rgba(0, 0, 0, 0.07)"),
                    ("shadow-lg", "0 4px 20px rgba(0, 0, 0, 0.10)"),
                    ("shadow-overlay", "0 24px 60px rgba(0, 0, 0, 0.25)"),
                ]
            ),
        ),
        ("overlay", collections.OrderedDict([("scrim", "rgba(0, 0, 0, 0.45)")])),
        (
            "font-family",
            collections.OrderedDict(
                [
                    ("font-sans", FONT_SANS),
                    ("font-title", FONT_TITLE),
                    ("font-quote", FONT_QUOTE),
                    ("font-num", FONT_NUM),
                    ("font-mono", FONT_MONO),
                ]
            ),
        ),
        (
            "font-size",
            collections.OrderedDict(
                [
                    ("text-display", "40px"),
                    ("text-h1", "32px"),
                    ("text-h2", "24px"),
                    ("text-h3", "18px"),
                    ("text-body-lg", "16px"),
                    ("text-body", "14px"),
                    ("text-caption", "13px"),
                    ("text-micro", "11px"),
                ]
            ),
        ),
        (
            "font-weight",
            collections.OrderedDict(
                [
                    ("weight-regular", "400"),
                    ("weight-medium", "500"),
                    ("weight-semibold", "600"),
                    ("weight-bold", "700"),
                ]
            ),
        ),
        (
            "line-height",
            collections.OrderedDict(
                [
                    ("leading-tight", "1.2"),
                    ("leading-snug", "1.4"),
                    ("leading-normal", "1.55"),
                ]
            ),
        ),
        (
            "letter-spacing",
            collections.OrderedDict(
                [
                    ("tracking-tight", "-0.02em"),
                    ("tracking-normal", "0"),
                    ("tracking-wide", "0.06em"),
                ]
            ),
        ),
        (
            "duration",
            collections.OrderedDict(
                [
                    ("duration-fast", "120ms"),
                    ("duration-base", "200ms"),
                    ("duration-slow", "280ms"),
                ]
            ),
        ),
        (
            "easing",
            collections.OrderedDict(
                [
                    ("ease-standard", "cubic-bezier(0.2, 0, 0.2, 1)"),
                    ("ease-decelerate", "cubic-bezier(0.16, 1, 0.3, 1)"),
                ]
            ),
        ),
        (
            "z-index",
            collections.OrderedDict(
                [
                    ("z-base", "0"),
                    ("z-dropdown", "100"),
                    ("z-sticky", "200"),
                    ("z-banner", "300"),
                    ("z-overlay", "400"),
                    ("z-panel", "410"),
                    ("z-modal", "500"),
                    ("z-toast", "600"),
                ]
            ),
        ),
    ]
)

CONTRAST = [
    {"name": "body text", "fg": "fg", "bg": "bg", "min": 4.5},
    {"name": "body text on surface", "fg": "fg", "bg": "surface", "min": 4.5},
    {"name": "secondary text", "fg": "fg-secondary", "bg": "bg", "min": 4.5},
    {"name": "secondary text on surface", "fg": "fg-secondary", "bg": "surface", "min": 4.5},
    {"name": "primary button label", "fg": "fg-inverse", "bg": "fg", "min": 4.5},
    {"name": "primary button label (hover)", "fg": "fg-inverse", "bg": "fg-hover", "min": 4.5},
    {"name": "danger button label", "fg": "on-error-solid", "bg": "error-solid", "min": 4.5},
    {"name": "danger button label (hover)", "fg": "on-error-solid", "bg": "error-solid-hover", "min": 4.5},
    {"name": "selected segment label", "fg": "on-surface-selected", "bg": "surface-selected", "min": 4.5},
    {"name": "error callout", "fg": "error-fg", "bg": "error-bg", "min": 4.5},
    {"name": "subtle danger button label", "fg": "error-fg", "bg": "card", "min": 4.5},
    {"name": "success callout", "fg": "success-fg", "bg": "success-bg", "min": 4.5},
    {"name": "warning callout", "fg": "warning-fg", "bg": "warning-bg", "min": 4.5},
    {"name": "info callout", "fg": "info-fg", "bg": "info-bg", "min": 4.5},
    {
        "name": "focus ring",
        "fg": "focus-ring",
        "bg": "bg",
        "min": 3.0,
        "note": "WCAG 2.1 SC 1.4.11 non-text contrast",
    },
    {
        "name": "interactive border",
        "fg": "border-interactive",
        "bg": "bg",
        "min": 3.0,
        "note": "WCAG 2.1 SC 1.4.11 non-text contrast",
    },
    {
        "name": "disabled text",
        "fg": "fg-disabled",
        "bg": "bg",
        "min": 0.0,
        "wcag_exempt": True,
        "note": "WCAG 2.1 SC 1.4.3 exempts inactive/disabled UI components.",
    },
]
for h in CAT_HUES + ["neutral"]:
    CONTRAST.append({"name": f"category badge: {h}", "fg": f"cat-{h}-fg", "bg": f"cat-{h}-bg", "min": 4.5})
    CONTRAST.append({"name": f"category mark on card: {h}", "fg": f"cat-{h}-solid", "bg": "card", "min": 3.0})

TYPOGRAPHY = {
    "faces": BRAND["typography"],
    "note": (
        "All four brand faces are commercial and licensed. They cannot be bundled as "
        "webfonts without the licence files, so every token names the brand face FIRST "
        "and falls back. The fallback stacks are house conventions chosen for shape: "
        "Optima/Candara behind the humanist Berthold Imago, Georgia behind the serif "
        "Kremlin Pro. The numeric face is for NUMBERS ONLY per the style sheet."
    ),
    "headline_subcopy_pct": [30, 60],
    "headline_pairs": [
        ["text-display", "text-body-lg"],
        ["text-h1", "text-h3"],
        ["text-h2", "text-body"],
        ["text-h3", "text-micro"],
    ],
    "body_pairs": [["text-body-lg", "text-body"], ["text-body", "text-caption"]],
}

ACCENT = BRAND["accent_policy"]

HOUSE = {
    "reason": (
        "The High 5 style sheet publishes colour, logo rules and typefaces. It publishes "
        "NO gradations, spacing, radius, shadow, elevation, numeric type scale, "
        "line-height, letter-spacing, duration, easing or z-index. Everything listed "
        "here is a Vibe house convention, not a High 5 brand standard."
    ),
    "scales": list(SCALES.keys()),
    "derived": [
        "Every non-anchor step in palette.json — the style sheet gives seven flat "
        "colours and no ramps (see tokens/derive_palette.py).",
        "The grey hue, derived from the brand black so the neutral carries the same "
        "cast as the logo box.",
        "The green hue, for success. The brand has no green, and encoding success in "
        "one of the six brand hues would collide with category colour.",
        "All font fallback stacks.",
    ],
    "non_palette_colors": {
        "rgba(0, 0, 0, 0.08 / 0.07 / 0.10 / 0.25)": "Shadow alphas. Neutral black at low alpha; no brand equivalent published.",
        "rgba(0, 0, 0, 0.45)": "Modal/slideout scrim (--scrim). House value.",
    },
}


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lum(hexv):
    h = hexv.lstrip("#")
    r, g, b = (_lin(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def check_contrast():
    """Refuse to emit tokens that cannot be read.

    Every colour PAIRING a component relies on is declared in CONTRAST and measured
    here, in both themes, before anything is written. This is what caught the one
    real constraint the palette imposes: white on the brand red measures 4.38:1 and
    fails AA, so the destructive fill had to move to a darker step.

    A pairing added to the semantic maps without a matching CONTRAST entry is
    invisible to this, which is why the module docstring says to add both.
    """
    failures = []
    for theme, m in (("light", LIGHT | CATS_L), ("dark", DARK | CATS_D)):
        for pair in CONTRAST:
            if pair.get("wcag_exempt"):
                continue
            ratio = contrast(hx(m[pair["fg"]]), hx(m[pair["bg"]]))
            if ratio < pair["min"] - 0.005:
                failures.append(
                    f"  {theme:<5} {pair['name']:<34} {ratio:.2f}:1  needs {pair['min']}:1"
                )
    if failures:
        raise SystemExit(
            "Contrast check failed — tokens NOT written:\n" + "\n".join(failures)
        )
    return sum(1 for p in CONTRAST if not p.get("wcag_exempt")) * 2


def block(pairs, resolver=None, indent="  "):
    out = []
    for name, val in pairs.items():
        v = f"var(--h5-{val.replace('/', '-')})" if resolver else val
        out.append(f"{indent}--{name}: {v};")
    return "\n".join(out)


checked = check_contrast()

# ---------- tokens.json ----------
tj = collections.OrderedDict()
tj["$schema_note"] = (
    "Machine-readable mirror of tokens.css. tests/test_tokens.py asserts the two stay "
    "in sync, that every colour resolves to palette.json, and that every contrast_pair "
    'meets its minimum in both themes. Colour tokens are palette references ("hue/step"); '
    "scale tokens are literal CSS values."
)
tj["source"] = PALETTE["source"]
tj["themes"] = collections.OrderedDict(
    [
        ("light", collections.OrderedDict(list(LIGHT.items()) + list(CATS_L.items()))),
        ("dark", collections.OrderedDict(list(DARK.items()) + list(CATS_D.items()))),
    ]
)
tj["scales"] = SCALES
tj["typography"] = TYPOGRAPHY
tj["contrast_pairs"] = CONTRAST
tj["accent_policy"] = ACCENT
tj["house_conventions"] = HOUSE
Path("tokens/tokens.json").write_text(json.dumps(tj, indent=2) + "\n")

# ---------- tokens.css ----------
L = []
A = L.append
A("/* ==========================================================================")
A("   High 5 design tokens — THE single source of truth for colour, type and scale.")
A("")
A("   Layer 1  Primitives  --h5-<hue>-<step>    the derived colour matrix.")
A("                                             Never reference these in components.")
A("   Layer 2  Semantic    --fg, --bg, --error-*  what components actually consume.")
A("   Layer 3  Scales      --space-*, --radius-*  house conventions (see BRAND.md).")
A("")
A("   Brand source:  High 5 Adventure Learning Center style sheet (2026-07-20)")
A("   Derived from:  brand.json -> palette.json -> here. Never hand-edit.")
A("                  python tokens/derive_palette.py && python tokens/generate.py")
A("   tests/ enforces that these files stay in sync and that contrast holds.")
A("   ========================================================================== */")
A("")
A("/* The four brand faces are commercial and licensed, so they cannot be bundled as")
A("   webfonts here. Each token names the brand face first and falls back; install the")
A("   licensed faces locally and the real thing is picked up with no change. */")
A("")
A("/* --------------------------------------------------------------------------")
A("   Layer 1 — PRIMITIVES. Twelve gradations around each brand anchor.")
A("   The step marked ANCHOR is the style-sheet colour itself, unchanged; every")
A("   other value is derived and is a house convention. tier=core is the subset a")
A("   component may consume; extended is for data/category encoding.")
A("   -------------------------------------------------------------------------- */")
A(":root {")
for hue, steps in P.items():
    anchor = PALETTE["anchors"].get(hue)
    core = [s for s, d in steps.items() if d["tier"] == "core"]
    A(f"  /* {hue} — anchor at {anchor}; core: {', '.join(map(str, core))} */")
    for step, d in steps.items():
        mark = "  /* ANCHOR — brand */" if d.get("anchor") else ""
        A(f"  --h5-{hue}-{step}: {d['hex']};{mark}")
A("}")
A("")
A("/* --------------------------------------------------------------------------")
A("   Layer 3 — SCALES (house conventions; the style sheet publishes none of these)")
A("   -------------------------------------------------------------------------- */")
A(":root {")
for group, items in SCALES.items():
    A(f"  /* {group} */")
    for n, v in items.items():
        A(f"  --{n}: {v};")
A("}")
A("")
A("/* --------------------------------------------------------------------------")
A("   Layer 2 — SEMANTIC TOKENS, light (default)")
A("   -------------------------------------------------------------------------- */")
A(":root {")
A(block(LIGHT, resolver=True))
A("")
A("  /* Category colours — data/category encoding ONLY, never UI chrome.")
A("     Red is absent by design: it is the accent. See BRAND.md. */")
A(block(CATS_L, resolver=True))
A("}")
A("")
A("/* --------------------------------------------------------------------------")
A("   DARK THEME — exactly ONE block, by design.")
A("")
A("   No @media (prefers-color-scheme: dark) rule here. Vibe's own index.css")
A("   currently duplicates its dark palette across a [data-theme] block AND a media")
A("   query, which is a guaranteed drift source. One selector is enough when the")
A("   app always resolves an explicit data-theme. tests/ fails if a second dark")
A("   block appears.")
A("   -------------------------------------------------------------------------- */")
A('html[data-theme="dark"] {')
A(block(DARK, resolver=True))
A("")
A("  /* Category colours — dark. */")
A(block(CATS_D, resolver=True))
A("}")
A("")
Path("tokens/tokens.css").write_text("\n".join(L))

print(
    f"tokens.json: {len(tj['themes']['light'])} light, {len(tj['themes']['dark'])} dark, "
    f"{sum(len(v) for v in SCALES.values())} scale tokens, {len(CONTRAST)} contrast pairs"
)
print(f"tokens.css : {len(L)} lines")
print(f"contrast   : {checked} pairings verified in both themes — all pass")
