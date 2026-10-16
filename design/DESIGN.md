# DESIGN.md

Apple-style design for websites and web apps. Read this before writing any UI.

## How to use this file

1. Import `foundation.css` once, globally. It contains:
   - every token and the type scale
   - layout: container, bands, tiles
   - buttons, links, form fields, segmented control, switch, table, status dots and sheets
2. Before building a page, open the matching reference and copy its structure:
   - `reference-landing.html` for marketing pages
   - `reference-app.html` for app UI (dashboards, admin, settings, forms)
3. Use the values here and in the references. If something isn't covered, use the nearest existing value rather than a new one.
4. Run the checklist at the end before calling a screen done.

## The idea

Apple's web design is typography, whitespace and real content, with almost no decoration. Each section says one thing. Emphasis comes from size, weight and gray, not from more color. If removing something loses nothing, remove it.

Apple doesn't publish a web design system; the Human Interface Guidelines cover native apps. The type, color, button, tile and layout values here come from apple.com's own CSS, and the rest follows the same patterns. SF Pro's license doesn't allow serving it as a web font, so Apple devices get the system font (SF) and everyone else gets Inter with optical sizes.

Liquid Glass is a native iOS and macOS material. On the web, the only glass is the translucent nav bar. Don't fake glass cards.

## 1. Never

These are what make a page read as AI-generated.

**Layout**
- A pill badge above the hero headline ("✨ New", "Introducing…").
- Grids of icon + title + two lines. Icons in colored circles or squares.
- Logo clouds, testimonial cards with avatars, star ratings, "Join 10,000+" avatar stacks.
- "Most popular" ribbons or one glowing pricing card.
- The default dashboard: stat cards with icons and "+20.1% from last month", "Recent sales" with avatars.
- Every section boxed in a card. Cards inside cards. One radius on everything.
- Tilted or 3D screenshots, fake browser chrome, shadows or glows behind screenshots.
- A text-left, screenshot-right hero as the default.
- On phones, a desktop dashboard squeezed narrow.

**Color and effects**
- Gradients anywhere: backgrounds, buttons, text, borders. Glows, blobs, grain, aurora, glass cards.
- Tailwind's default palette: slate, zinc, gray, indigo, violet, purple, `#6b7280`, `#e5e7eb`, `#09090b`.
- Tinted near-blacks like `#0a0a0a` or `#111`. Black is `#000`; text is `#1d1d1f`.
- Shadows on cards that sit on a gray background. Hover lift (`translateY(-4px)` plus a shadow).

**Type and copy**
- Weights 700–900. `tracking-tight` on everything. All-caps labels or eyebrows.
- One word of a headline in another color, in italic or in a gradient.
- Emoji in UI. `→` on buttons or links.
- These words: seamless, unlock, elevate, supercharge, empower, effortless, revolutionize, next-gen, cutting-edge, game-changer, all-in-one, robust, leverage, "in seconds", "built for modern teams".
- Generic triads like "Fast. Secure. Reliable."
- The same sentence twice on one page, e.g. the hero intro repeated in a tile.

**Motion**
- Fade-up on every section, staggered cascades, parallax, animated gradients, bouncy springs.

## 2. Type

The stacks live in `foundation.css`:
- `--font-text`: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`
- `--font-display`: the same stack with "SF Pro Display". Use it for 20px and up.

Load Inter with its optical size axis so it switches between text and display cuts the way SF does:
- npm: `npm i @fontsource-variable/inter`, then `import "@fontsource-variable/inter/opsz.css"`
- or CDN: `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5/opsz.css">`

Use these classes. Sizes step down at Apple's breakpoints, 1068px and 734px. Values are size / line-height / letter-spacing.

| Class | Use | Desktop | ≤1068px | ≤734px | Weight |
|---|---|---|---|---|---|
| `t-display` | hero headline | 80 / 1.05 / -0.015em | 64 | 48 | 600 |
| `t-headline` | section headline | 48 / 1.083 / -0.003em | 40 | 32 | 600 |
| `t-title` | large tile or plan titles | 32 / 1.125 / 0 | 28 | 24 | 600 |
| `t-eyebrow` | product name above a headline | 24 / 1.167 / 0 | 21 | 19 | 600 |
| `t-intro` | 1–2 sentences under a headline | 28 / 1.286 / 0 | 24 | 21 | 400 |
| `t-lead` | two-tone tile copy | 21 / 1.381 / 0 | 19 | 17 | 600 |
| `t-body` | paragraphs | 17 / 1.471 / -0.022em | same | same | 400 |
| `t-small` | secondary text, app body | 14 / 1.429 / -0.016em | same | same | 400 |
| `t-caption` | footnotes, nav links, labels | 12 / 1.333 / -0.01em | same | same | 400 |

Apple tracks SF slightly positive at 19–32px. This system uses 0 there, because Inter (what most Android and Windows visitors get) already looks loose at those sizes.

Rules:
- Only weights 400 and 600. Headlines are 600, never bold. `foundation.css` resets `h1`–`h6`, `b`, `strong` and `th` to 600.
- On marketing pages the largest text is at least 4× body (80 vs 17).
- Sentence case everywhere, no all caps.
- Headlines get `text-wrap: balance`, paragraphs get `text-wrap: pretty`. Keep body lines under about 70 characters.
- Big standalone numbers use normal figures. Use `tabular-nums` only in tables and number columns.
- Format every number with one locale. For Indonesia use `Intl.NumberFormat("id-ID")`:
  - `Rp 4.820.500` and `0,7%`
  - compact `912 rb` and `1 jt`
  - never "M" for million, which Indonesians read as *miliar*

Two-tone copy is Apple's signature. In `t-lead`, the lead phrase is `--text` and the rest is `--text-3`, at the same size and weight. Below 735px the gray switches to `--text-2` for contrast.

```html
<p class="t-lead"><strong>Every way to pay.</strong> Cards, QRIS and bank transfers on one terminal.</p>
```

Highlight whole sentences, never a single word.

## 3. Color

All tokens are in `foundation.css`. Light values sit on `:root`, and dark values sit under `.theme-dark` and `data-theme`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--text` | `#1d1d1f` | `#f5f5f7` | primary text |
| `--text-2` | `#6e6e73` | `#a1a1a6` | secondary text, any size |
| `--text-3` | `#86868b` | `#86868b` | 19px+ semibold only (two-tone copy) |
| `--bg` | `#ffffff` | `#000000` | page |
| `--bg-alt` | `#f5f5f7` | `#161617` | alternate bands, sidebar |
| `--bg-elevated` | `#ffffff` | `#1d1d1f` | tiles on gray, sheets |
| `--accent` | `#0071e3` | `#0071e3` | filled buttons, switches, the one chart series |
| `--link` | `#0066cc` | `#2997ff` | text links, selected icons |
| `--fill` | `#e8e8ed` | `#333336` | gray buttons, segmented track, search |
| `--separator` | `#d2d2d7` | `#424245` | rules, table header line |
| `--separator-soft` | `#e8e8ed` | `#2c2c2e` | row lines, gridlines |
| `--green` `--red` | `#248539` `#d70015` | `#30d158` `#ff453a` | status dots and short deltas |
| `--orange` | `#ff9500` | `#ff9f0a` | status dots only, never text |

Rules:
- There's one accent. Blue marks what you can act on or what is selected: buttons, links, switches, the selected item, and the single series in a chart. Nothing decorative is blue.
- Bands alternate `#fff` and `#f5f5f7`. Use at most one black band per page.
- Status colors appear only in app UI, as dots or short deltas, always next to a text label.
- "New" is orange text (`--new`), never a filled badge.
- Dark mode:
  - App UI follows the system (`<html data-theme="auto">`) and offers an Auto/Light/Dark control.
  - Marketing pages stay light. A dark band is a deliberate choice (`class="theme-dark"` on the band).
  - Translucent bars mix from `--bg` (`color-mix(in srgb, var(--bg) 80%, transparent)`) so they never show as a gray strip on black.

## 4. Layout

- Breakpoints are 1068px and 734px (max-width), the same as apple.com.
- Width and padding (all in `foundation.css`):
  - `.container`: 980px, then 692px at ≤1068px, then 87.5% at ≤734px.
  - The hero visual can go up to 1100px wide.
  - `.band` padding: 120px, then 100px, then 80px.
- Spacing scale for layout: 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 120. Keep spacing tight inside a group and jump big between groups. Component padding (buttons, fields, tiles) comes from `foundation.css`.
- Center short stacks of 3 lines or fewer: heroes, CTA bands, headlines over centered visuals. Left-align longer copy, tiles and all app UI.

## 5. Marketing page recipe

1. **Nav:** 52px, sticky, translucent (`saturate(180%) blur(20px)`). Product name on the left at 21px/600, 3–5 links on the right at 12px, one `btn btn-xs`.
2. **Hero:** eyebrow, display headline (2–6 words), a one-line intro that says what the product is, a pill pair, then one big product visual cropped by the band edge.
3. **3–6 bands.** Each band says one thing: a headline, at most 2 sentences and one visual. Adjacent bands differ in layout and background.
4. **Compare or pricing** as plain columns.
5. **CTA band:** headline, one filled pill, one text link.
6. **Footer** on `#f5f5f7` at 12px: numbered footnotes first, then links, then copyright.

Rotate these band layouts:
- **Centered stack:** headline and intro centered, visual full width below.
- **Highlights:** white tiles on `#f5f5f7` in 2 columns, with `t-lead` copy at the top-left and one visual per tile. The visual can run off the tile's bottom edge (`.tile-bleed`).
- **Big number:** one number at 80–96px/600 with a short gray caption, under its copy. No icon, no box around it.
- **Dark band:** `.theme-dark`, centered headline, one product visual.
- **Compare:** product columns aligned with `grid-template-rows: subgrid`, hairline rows, one filled pill per column and "Learn more ›" under it. On phones the table scrolls sideways, with the next column peeking in.

Visuals:
- Every band has one real visual: a product screenshot with real data, a UI crop, a photo or a big number. A band without a visual gets cut.
- Use real screenshots of your real product: 2× PNG or WebP, flat, with a 1px `rgba(0,0,0,.08)` edge, an 18px top radius and no shadow. The references draw theirs in HTML only because Till isn't real.
- Give phones their own crop. Show the phone layout of the app, not the desktop screenshot shrunk to unreadable text.
- Use real content: real names, real currency and times. Numbers must agree across the page.

## 6. Components

All of these are in `foundation.css`. Copy the markup from the references.

**Buttons** are pills (`border-radius: 980px`) at weight 400.

| Class | Font | Padding | Use |
|---|---|---|---|
| `btn btn-lg` | 17px | 12px 22px | checkout, rare |
| `btn` | 17px | 8px 16px | marketing CTAs |
| `btn btn-sm` | 14px | 6px 14px | app toolbars, forms, sheets |
| `btn btn-xs` | 12px | 4px 11px | nav |

The default is filled (`#0071e3`, hover `#0077ed`, active `#006edb`). The other variants are `btn-outline` and `btn-gray`. Use one filled button per view, or one per column in a compare table. Pair a filled button with an outline button or a text link.

**Text links** are `#0066cc` and underline on hover only. Calls to action get a chevron, never "→": `<a class="more" href="…">Learn more</a>` renders as "Learn more ›".

**Tiles** (`.tile`) are `--bg-elevated` on `--bg-alt` with an 18px radius. Padding is 51px 62px, then 42px 27px at ≤1068px, then 33px 27px at ≤734px. No border and no shadow. A tile on white gets `.tile-on-white`, which adds `--shadow-tile`. Big media panels use a 28px radius.

**Fields** (sign-in, checkout, sheets) follow Apple Account: 56px tall, 12px radius, 1px `--field-border` and a floating label that shrinks from 17px to 12px. On focus they get a blue border and a 4px `--focus` ring.

```html
<div class="field"><input id="email" type="email" placeholder=" "><label for="email">Email</label></div>
```

**Segmented control** (`.seg`): a pill track in `--fill`, with the selected segment white and a hairline shadow, at 13px. Use it instead of tabs for 2–4 options.

**Switch** (`input.switch`): a 40×24 pill, accent when on.

**Table** (`.table`): no outer border, no zebra stripes, no vertical lines.
- The header is 12px in `--text-2`, sentence case, with a 1px `--separator` under it.
- Rows are 44px with `--separator-soft` lines.
- `.num` cells are right-aligned and tabular.

**Status** (`.status.ok`, `.wait`, `.bad`, or plain for neutral): a 7px dot plus plain text.

**Sheet** (`.scrim > .sheet`, with `.sheet-title`, `.sheet-sub`, `.sheet-actions`): centered and at most 460px wide, with an 18px radius and `--shadow-float`. On phones it becomes a bottom sheet. A gray "Cancel" and the filled action sit at the bottom right. Esc and a click on the scrim close it.

## 7. App UI

- **Shell:** a 240px sidebar on `--bg-alt` with a hairline right edge, content on `--bg`, and a sticky translucent toolbar 64px tall.
- **Density:** 14px body, 12px labels, 32px controls, 44px rows.
- **Sidebar items:** 32px tall, 8px radius, 16px line icons in `--text-2`. The selected item gets a 7% `--text` fill, weight 600 and an icon in `--link`.
- **Toolbar:** a page title at 28px/600 that stays true whatever filter is picked ("Overview", not "Today"). On the right: a segmented control, a pill search field in `--fill` and one `btn btn-sm`.
- **Summary:** one hero number per view (48px/600), with a 12px label above it and a delta below, e.g. "+12% vs last Thursday" (signed, colored, against a named period). Other stats are 21px/600. No stat cards, no icons, no boxes.
- **Charts:**
  - One accent color. Bars are at most 24px wide with 4px rounded tops.
  - Gridlines are 1px `--separator-soft`, and y labels sit on the right in compact locale format.
  - Only the peak gets a label, on a `--bg` background. Show a tooltip on hover and focus, and keep a screen-reader table.
  - Partial data (an hour still open) mixes the accent 45% toward `--bg`.
- **Phones (≤734px) get an app layout, not a squeezed dashboard:**
  - a bottom tab bar for up to 5 sections (22px icons, 10px labels, translucent)
  - two-line list rows instead of table columns
  - a bottom sheet instead of a centered dialog
  - Settings is still reachable from the top bar
- **Empty states:** a 17px/600 title, one `--text-2` line and one button. No illustration.
- **Icons:** only in app chrome (sidebar, tab bar, toolbar, actions). Line icons at 16–22px with a 1.5–1.6 stroke, in `--text-2`. Never in colored containers, never as decoration on marketing pages.

## 8. Motion

- Hover and press change color only, over 100ms linear. No scale, no lift.
- A marketing page gets at most one orchestrated moment: the hero fades in and rises 16px over about 900ms.
- Sheets fade and scale from 0.96 to 1 over 240ms ease-out. A bottom sheet rises 32px instead.
- No scroll-triggered animations on sections. Respect `prefers-reduced-motion`.

## 9. Copy

- Headlines are short sentences with a period, usually 2–6 words: "Get paid. Go home."
- The hero intro says plainly what the product is: "The payment terminal for small shops."
- Specific beats clever. Use numbers, times and prices: "Paid out by 09:00."
- Intros are at most 2 sentences. Tile copy is 25 words or fewer.
- Buttons are 1–2 word verbs: "Get started", "Order", "Create invoice".
- Claims get a superscript footnote that's explained in the footer.
- App UI is plain and calm: "Paid", "Pending", "Tomorrow, 09:00". No exclamation marks.

## 10. Tailwind v4

If the project uses Tailwind, import the foundation and remove Tailwind's defaults, so the classes that cause the AI look don't exist:

```css
@import "tailwindcss";
@import "@fontsource-variable/inter/opsz.css";
@import "./foundation.css";

@theme {
  --color-*: initial;
  --shadow-*: initial;
  --radius-*: initial;
  --font-weight-*: initial;
  --tracking-*: initial;
  --text-*: initial;
  --breakpoint-*: initial;

  --breakpoint-md: 735px;   /* tablet, apple.com's 735–1068 range */
  --breakpoint-lg: 1069px;  /* desktop */

  --font-weight-normal: 400;
  --font-weight-semibold: 600;

  --text-caption: 12px; --text-caption--line-height: 1.33337; --text-caption--letter-spacing: -0.01em;
  --text-small: 14px;   --text-small--line-height: 1.42859;   --text-small--letter-spacing: -0.016em;
  --text-body: 17px;    --text-body--line-height: 1.47059;    --text-body--letter-spacing: -0.022em;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-tile: 18px;
  --radius-panel: 28px;

  --shadow-tile: 8px 8px 16px 0 rgba(0, 0, 0, 0.08);
}

@theme inline {
  --font-sans: var(--font-text);
  --color-bg: var(--bg);
  --color-bg-alt: var(--bg-alt);
  --color-elevated: var(--bg-elevated);
  --color-ink: var(--text);
  --color-ink-2: var(--text-2);
  --color-ink-3: var(--text-3);
  --color-link: var(--link);
  --color-accent: var(--accent);
  --color-fill: var(--fill);
  --color-line: var(--separator);
  --color-line-soft: var(--separator-soft);
  --color-green: var(--green);
  --color-orange: var(--orange);
  --color-red: var(--red);
  --color-white: #fff;
  --color-transparent: transparent;
  --color-current: currentColor;
}
```

- Use the `t-*` classes for headlines and copy, and the utilities above for app UI.
- Use the foundation classes for components (`btn`, `more`, `field`, `tile`, `table`, `sheet`). Don't rebuild them from utilities.
- Spacing utilities: use only the steps on the scale. Those are 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20 and 30 (4–120px). Nothing like `p-7` or `mt-9`.
- The only shadows are `shadow-tile` and `var(--shadow-float)` on floating elements.
- With shadcn/ui, restyle the copied components and drop its default theme. Button becomes the `btn` classes. Input becomes `field`, or 36px tall with an 8px radius and a 1px `line` border. Card is never a marketing section; in app UI it has no border and no shadow.

## 11. Before you finish

1. Squint: one thing dominates each band or screen.
2. On marketing pages the largest text is at least 4× body.
3. The only colors are grays, `#0071e3` / `#0066cc`, and status dots in app UI.
4. The only weights are 400 and 600.
5. No icon is decoration, and no card holds an icon, a title and two lines.
6. Every band has one real visual, adjacent bands differ in layout and background, and no sentence repeats.
7. Headlines are short sentences with periods. No banned words appear. Numbers use one locale and agree across the page.
8. Shadows appear only on floating elements, plus `.tile-on-white`.
9. Check these:
   - It works at 390px, 734px and 1068px, and phones get the app layout.
   - Focus is visible and reduced motion is respected.
   - App UI is checked in dark mode, and the toolbar shows no gray strip on black.
10. Put the page next to the matching reference. If yours looks busier, remove things until it doesn't.
