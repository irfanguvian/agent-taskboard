# DESIGN.md

How this product looks, moves and talks: in the web app, on the website and in every piece of UI text.

**Built like Apple, dressed calm.** The structure, rules and behavior come from Apple's design approach: hierarchy from type, familiar patterns, one leading edge, concentric corners, designed states, real feedback. The look comes from a calm CRM dashboard: a soft gray canvas, white cards with thin borders, ink buttons and pastel color that only ever carries meaning.

**How to use this file**
- Put it at the repo root and tell your agent: "Follow DESIGN.md for every UI change."
- Read it before any UI or UI copy work. Where it disagrees with your habits, follow this file.
- Use the tokens and text styles in §17. Never invent colors, font sizes, radii or shadows.
- Prefer the patterns in §9–§12 to new ones.
- Run the checklist in §19 before you call a screen done.

---

## 0. The merge in one table

Where the two sources disagreed, this is what won and why.

| Topic | Decision | From |
|---|---|---|
| Canvas, cards, borders | Gray canvas `#F5F6F8`, white cards, 1px border, no card shadows | Dashboard |
| Color roles | **Ink = do.** Primary actions are near-black. **Lavender = here.** Selection, focus, "on", applied filters, the main chart series and text links | Both |
| Pastels | Six pastel hues for status and charts, soft fill + dark text of the same hue | Dashboard |
| Dark mode | Fully designed, black base, surfaces lighten as they rise | Apple |
| Text styles | Apple's names and two scales (touch and website, desktop app), dashboard density on desktop | Both |
| Weights | 400 read, 500 UI labels, 600 titles and numbers. No 700 | Dashboard |
| Shape | Capsule buttons, chips and search. 16px cards. Concentric corners | Apple |
| Floating things | Shadow with a built-in 0.5px ring, never a CSS border plus shadow | Apple |
| Home screen | A summary, not a KPI wall: one hero metric, a few highlights, then the list | Apple |
| Icon chips on cards | Removed. Icon + label in the hue color instead | Apple |
| Avatars | Initials on gray, so status pills stay the only color in a row | Apple |
| Detail view | Floating right drawer (the inspector), create and edit in a centered sheet | Both |
| Icons | lucide, stroke 1.75 (ships with shadcn/ui) | Dashboard |
| Labels | Title Case for buttons, tabs, menus, headers. Sentence case for sentences | Apple |
| Motion | Apple durations and easing. No bounce, no count-up, no shimmer | Both |
| Chart area | Fades from accent 18% to transparent: the only gradient allowed | Apple |

---

## 1. Principles

1. **Content first.** The data is the loudest thing on screen. Chrome is thin, white or gray, and quiet. Test: hide the content, and what's left should look almost blank.
2. **One purpose per screen.** In 3 seconds a person should know what the screen is for and what to do next.
3. **Hierarchy from type, not decoration.** Size, weight and gray level do the work. Squint: one thing leads, with 2–3 clear levels below it.
4. **Familiar patterns.** Lists, sidebars, toolbars, sheets, menus, segmented controls, tab bars. Invent only when nothing familiar fits.
5. **Color means something.** Neutrals do 90% of the work. A color is a status, a selection or a chart series, never decoration.
6. **Restraint.** Every element earns its place. One primary action per view. If removing something loses nothing, remove it.
7. **Craft.** One leading edge, one spacing scale, nested corners, real punctuation. Every state is designed: empty, loading, error, long text, no permission.
8. **Feedback.** Every press, save and change gets an immediate, visible response. Motion shows where things came from and where they went.
9. **For everyone.** Contrast, scalable text, keyboard access, reduced motion and reduced transparency are part of the design, not a final pass.

---

## 2. Make it yours, not Apple's

- **One accent.** Lavender is the default. To rebrand, swap the three accent tokens (`--accent`, `--accent-soft`, `--accent-text`) for another pastel's solid, soft and fg values, or your brand color if it passes the same contrast checks. Don't pick mint, rose, butter or peach: they carry status.
- Your own wordmark, content and voice.
- **Don't copy Apple:**
  - No Apple logo, product names, product photos or copy.
  - Don't self-host SF Pro and don't use SF Symbols. Both are licensed for Apple platforms only. The system font stack renders SF on Apple devices for free.
  - Don't rebuild apple.com layouts: product name above a giant headline in every section, blue "Learn more / Buy" pill pairs, gray tile grids, model comparison tables.

---

## 3. Color

### Neutrals

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | #F5F6F8 | #000000 | app background, alternate website sections, sheet backgrounds |
| `--bg` | #FFFFFF | #000000 | plain website sections |
| `--surface` | #FFFFFF | #1C1C1E | cards, sidebar, table, drawer |
| `--surface-raised` | #FFFFFF | #2C2C2E | menus, popovers, active segment, rows inside a sheet |
| `--fill` | gray 10% | gray 24% | control backgrounds: search, segmented track, gray buttons, skeletons, pressed rows |
| `--hover` | black 3% | white 5% | row hover |
| `--line` | #E7E9ED | #2E2E32 | card borders, separators, table rows, chart grid |
| `--field-border` | #8E9099 | #6C6C72 | text field and checkbox edges (3:1) |
| `--fg` | #16181D | #F5F5F7 | primary text, numbers |
| `--fg-muted` | #4E5361 | #AEAEB2 | labels, secondary text |
| `--fg-subtle` | #6A7080 | #98989D | captions, placeholders, table headers, axis ticks |
| `--fg-disabled` | #AEB2BB | #5A5A5F | disabled text, the Inactive status dot and chart slice |

All text tokens pass 4.5:1 on `--canvas`, `--surface` and `--surface-raised`.

### Ink and accent

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ink` | #1E222B | #F5F5F7 | Prominent buttons, active pagination |
| `--ink-hover` | #2B303B | #E3E3E8 | Prominent hover |
| `--on-ink` | #FFFFFF | #16181D | text on ink |
| `--accent` | #8E88F2 | #8E88F2 | main chart series, switch "on", checked box, focus ring, dots |
| `--accent-soft` | #EEEDFD | #333248 | selected rows and nav, applied filters, Tinted buttons |
| `--accent-text` | #4C46B6 | #BDB9FF | text links, text on `--accent-soft` |

- **Ink = do.** Anything that performs an action and needs weight: the Prominent button, active page number.
- **Lavender = here.** Anything selected, focused, switched on, checked or applied. Also the one series in a chart, and inline text links (links need color to be found).
- Lavender is never a button fill, a heading color, a section background or a gradient. That's what keeps it from reading as "AI purple".

### Pastels

Each hue has three values. Text on a soft fill is always that hue's `-fg`, never white. Solids stay the same in dark mode.

| Hue | `-soft` light | solid | `-fg` light | `-soft` dark | `-fg` dark |
|---|---|---|---|---|---|
| `lavender` | #EEEDFD | #8E88F2 | #4C46B6 | #333248 | #BDB9FF |
| `mint` | #E4F5ED | #6CC49F | #1E7752 | #2C3E38 | #8EDDB9 |
| `sky` | #E5F1FC | #7DB5E9 | #28649A | #2F3B47 | #9DCBF5 |
| `peach` | #FDEEE5 | #F2A67F | #A4502A | #473831 | #F9BE9E |
| `butter` | #FBF4DD | #E6C65E | #876712 | #443E2B | #EDD484 |
| `rose` | #FCE9ED | #EE98A9 | #A23A52 | #46353A | #F7B3C1 |

### Semantic roles

| Meaning | Color |
|---|---|
| Positive change, success | `mint` |
| Negative change | `rose` |
| Warning | `butter` (icons and dots, or a pill with a word) |
| Info | `sky` |
| Error, destructive | `--danger` text (#CC3B3B / #FF6B63), `--danger-fill` (#CC3B3B) only for the final confirm button |

Status colors always sit next to a word or an icon. Never color alone.

### Engagement status

| Status | Hue |
|---|---|
| New Lead | `sky` |
| Active | `mint` |
| In Negotiation | `lavender` |
| Needs Follow-Up | `butter` |
| At Risk | `peach` |
| Inactive | neutral: `--fill` bg, `--fg-muted` text, `--fg-disabled` dot and chart slice |

### Charts

Series order: `lavender`, `mint`, `sky`, `peach`, `butter`, `rose` (solids). One series is always the accent. Never more than 6.

### Rules

- Separate regions by background level first (canvas → surface), then a 1px `--line`. Never a border plus a shadow on the same box.
- **Dark mode is designed, not inverted.** Black base, surfaces lighten as they rise (`#1C1C1E` → `#2C2C2E`), text and pastel fg lighten. Apps follow the system with a manual override.
- Category colors (tags, calendars) appear only when people chose them, as small dots.
- Photos and content can be colorful. The UI around them stays neutral.

---

## 4. Typography

**One family:** the system font, with Inter as the fallback. On Apple devices that renders SF; everywhere else, Inter. Load Inter with optical sizes (`@fontsource-variable/inter/opsz.css`, or Google Fonts `Inter:opsz,wght@14..32,400..600`). Turn on `font-feature-settings: "cv11", "ss01"` (Inter's single-storey a and open digits; SF ignores them).

Text styles use Apple's names. Sizes are font size / line height in px. Desktop app sizes apply inside `.app` at 1024px and up with a mouse; touch screens and websites keep the left column.

| Style | Touch & website | Desktop app | Weight | Use |
|---|---|---|---|---|
| Large Title | 34/41 | 24/30 | 600 | page title, once per screen |
| Title | 22/28 | 18/24 | 600 | sheet, drawer and section titles |
| Headline | 17/22 | 15/20 | 600 | card titles, row titles, emphasized labels |
| Body | 17/22 | 14/20 | 400 | default text, table cells |
| Label | 15/20 | 13/18 | 500 | buttons, nav items, segments, chips, field labels |
| Subheadline | 15/20 | 13/18 | 400 | row subtitles, metadata, the email under a name |
| Footnote | 13/18 | 12/16 | 400 | helper text, section headers and footers; 500 for table headers and pills |
| Caption | 12/16 | 11/14 | 400 | timestamps, axis ticks, kbd chips |
| Metric | 40/48 | 34/40 | 600 | the one big number on a screen |
| Metric 2 | 28/34 | 24/30 | 600 | numbers on highlight cards, donut totals |
| Display (website) | 64/68, 40/44 on phones | – | 600 | the hero headline, big-number sections |
| Section (website) | 40/44, 28/34 on phones | – | 600 | section headlines |
| Lead (website) | 21/30, 19/27 on phones | – | 400 | 1–2 sentences under a headline |

- **Weights:** 400 for reading, 500 for UI labels, 600 for titles and numbers. Nothing else.
- **Hierarchy** comes from size, weight and gray, never from color, italics or all caps. Usually 4–5 styles on a screen, Large Title once.
- Paragraphs of 2+ lines use line-height 1.45. Long reading is 18/1.6, at most 680px wide.
- **Numbers:**
  - Tables, tooltips, deltas and anything in a column use `tabular-nums`, right-aligned.
  - Metric and Metric 2 use `--font-rounded` with normal figures.
  - Currency, units and qualifiers are smaller and in `--fg-muted`, placed where the language puts them: Rp **13.500.000**, **12,5** km, Rp **2,41** miliar.

---

## 5. Layout and spacing

- **Grid:** 4px. Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128.
- **Breakpoints:** phone < 744px, tablet 744–1023px, desktop ≥ 1024px, wide ≥ 1440px.
- **One leading edge.** Text, icons and separators line up. Row separators start where the row's text starts.
- **Group** by closeness first (tight inside, roomy between), then background, then a hairline. Never a box inside a box.
- Center only short stacks: hero, a section headline above a centered visual, empty states, alerts.

### App shell (desktop)

```
┌────────────┬──────────────────────────────────────────────────┐
│  Sidebar   │ Toolbar 64: Large Title · search · icons · Add   │
│  248px     ├──────────────────────────────────────────────────┤
│            │ [Hero metric + chart   8 cols] [By status 4 cols]│
│  nav       │ [Highlight] [Highlight] [Highlight]  (4 each)    │
│            │ [Main list or table                    12 cols]  │
│  user      │                                                  │
└────────────┴──────────────────────────────────────────────────┘
```

- Content: 12-column grid, max 1440px. Page padding 24 (32 at ≥ 1440). Grid gap 16 (20 at ≥ 1440). Card padding 20, card header → content 16.
- ≥ 1280: full sidebar. 1024–1279: 72px icon rail with tooltips. < 1024: tab bar (§11).
- Tablet: phone patterns, 24px margins, two columns where content fits.

### Website

- Page margins 16 / 24 / 32 (phone / tablet / desktop). Sections max 1120px, reading max 680px.

### Density

| | Touch | Desktop with a mouse |
|---|---|---|
| Controls, buttons | 44 | 36 (Small 32) |
| Sidebar rows | 44 | 36 |
| Table rows | list rows | 56 two-line, 44 one-line |
| Menu items | 44 | 32 |
| Minimum target | 44 | 32 |

---

## 6. Shape, depth and material

### Radii

| Token | Value | Use |
|---|---|---|
| `--r-xs` | 6px | checkboxes, kbd chips, small tags |
| `--r-sm` | 8px | nav rows, menu items, row highlights, tooltips, pagination |
| `--r-md` | 12px | text fields, menus, popovers, grouped sections inside sheets |
| `--r-lg` | 16px | cards |
| `--r-xl` | 20px | sheets, dialogs, the drawer, large screenshots |
| `--r-2xl` | 28px | phone sheet top corners, phone screenshots, large media |
| `--r-full` | 999px | buttons, search, segmented controls, chips, status pills, switches, avatars, badges, toasts |

- **Concentric corners:** when the gap between a rounded thing and its container is smaller than the container's radius, inner radius = outer − gap. A menu item 4px inside a 12px menu is 8px. A 20px drawer with 8px padding holds 12px panels. When the gap is larger, use the normal scale.
- Bigger things get bigger radii. Never one radius everywhere.

### Depth

- **Cards:** `--surface` + 1px `--line`, no shadow. Depth comes from canvas → surface.
- **Floating things only** get shadows: menus, popovers, the drawer, sheets, toasts, dragged items. Their shadow includes a 0.5px ring, so they never also get a CSS border.
- `--shadow-control` for the active segment and switch knob.

### Material

- `--material` + `backdrop-filter: var(--blur)` for bars only: the app toolbar, website nav, phone tab bar, menus. Content scrolls underneath.
- At the top of a page the bar is transparent with no separator. It becomes material with a hairline once content scrolls under it.
- Never on cards or content. No glow, no glass cards. Solid fallback with `prefers-reduced-transparency`.
- **Hairlines:** 1px, or 0.5px on high-density screens (`--hairline`).

---

## 7. Icons and imagery

- **lucide** (`lucide-react` or `lucide`), stroke 1.75, `currentColor`. 16px in inputs, chips and rows; 18px in nav and toolbars; 24px in the phone tab bar. About 1.2× the text beside them.
- Icons only where they help recognition: navigation, toolbar actions, highlight card labels, empty states. Not beside every heading, **never inside colored circles or squares**, never as feature decoration.
- Selected icons take `--accent-text`. Never mix outline and filled sets.
- Icon-only buttons need an `aria-label` and a tooltip on desktop.
- **Imagery:** real screenshots, real photos, real data. Screenshots are flat (no tilt, no fake browser frame), with a hairline edge and a radius matching their container.
- No stock illustrations, 3D blobs, gradient meshes, AI art or emoji.
- **Avatars:** photo, or initials on `--fill` with `--fg-muted` text. Gray keeps status pills the only color in a row.

---

## 8. Components

### Buttons

Capsules with Title Case labels, Label style (500).

| Type | Look | Use |
|---|---|---|
| Prominent | `--ink` fill, `--on-ink` text | the main action, one per view |
| Tinted | `--accent-soft` fill, `--accent-text` text | secondary actions that still matter |
| Gray | `--fill`, `--fg` text | neutral actions: Export, Cancel in desktop sheets |
| Plain | `--fg-muted` text, `--hover` fill on hover | toolbars, inline actions, Cancel in phone sheets |
| Destructive | `--danger` text on Gray; `--danger-fill` with white text only for the final confirm | delete, remove |

- **Sizes:** Large 50 (touch, end of a flow, full width on phones). Regular 36 with a mouse, 44 on touch, padding 0 16. Small 32, padding 0 12, for chips, toolbars and the website nav; on touch it keeps a 44px tap area.
- **Icon button:** 36×36 circle, Plain style.
- **States:** hover → `--ink-hover` for Prominent, `--hover` overlay for the rest. Pressed 0.7 opacity. Disabled 0.35. Loading: a spinner replaces the label, width stays.

### Search

- Capsule, `--fill`, no border, 36 tall (44 touch). Leading 16px magnifier in `--fg-subtle`, placeholder "Search", trailing `⌘K` chip (Caption, 1px `--line`, `--r-xs`).
- Focus: `--surface` fill and the focus ring. A clear button appears while typing. Esc clears.

### Segmented control

- Capsule `--fill` track, 2px padding, 2–5 equal segments, 32 tall (28 segments).
- Segment: Label, `--fg-muted`. Selected: `--surface-raised`, `--fg`, `--shadow-control`.
- Use it to switch views of the same content: date ranges, table views (All · Active · At Risk · New, with counts in `--fg-subtle`).

### Filter chips

- Small (32) capsule, `--surface` with 1px `--line`, Label, trailing chevron.
- Applied: `--accent-soft`, `--accent-text`, no border, shows the count (`Status · 2`) and an × to clear. "Clear All" as a Plain button.

### Status pill

- 22px capsule, padding 0 10, Footnote 500, hue `-soft` fill + hue `-fg` text, leading 6px dot in the hue solid. No border. Title Case.

### Delta

- A small pill like the status pill: `mint` with ▲ for up, `rose` with ▼ for down, tabular figures. The comparison ("vs last quarter") goes once beside it in Footnote `--fg-subtle`, not under every number.

### Switch and checkbox

- **Switch:** capsule, 51×31 on touch, 38×22 with a mouse. Off `--fill`, on `--accent`. White knob with `--shadow-control`.
- **Checkbox:** 16px, `--r-xs`, 1px `--field-border`. Checked: `--accent` fill, white check. Checkboxes for multi-select on desktop only; checkmark rows for single choice.

### Lists

- **Plain list:** rows on `--surface`, inset hairlines.
- **Grouped list** (forms, settings, sheets): sections on `--surface`, `--r-md`, hairlines inset to the text, 32px between sections. Optional header (8px above) and footer, both Footnote `--fg-muted`.
- **Row:** optional leading icon or avatar, title (Body) with optional subtitle (Subheadline, `--fg-subtle`), trailing value (`--fg-muted`) and accessory: chevron for navigation, a switch, or a checkmark. The whole row is the target. Pressed: `--fill`.

### Table

- Inside a card with no padding.
- **Toolbar** (padding 16 20): segmented view control on the leading side; search (240), filter chips, Export (Gray) and a column toggle on the trailing side.
- **Header row:** 40px, Footnote 500, `--fg-subtle`, Title Case, hairline below, no fill. Sortable columns show a chevron on hover.
- **Rows:** 56px (two-line cells) or 44px, hairlines inset 20px both sides, none after the last. Hover `--hover`, selected `--accent-soft`, the whole row opens the drawer.
- **Cells:** client = avatar 32 + name (Body 500) over email (Subheadline `--fg-subtle`). Owner = avatar 24 + name. Engagement = score + a 64×4 bar (track `--fill`; ≥ 70 `mint`, 40–69 `butter`, < 40 `peach`). Last contact relative ("2d ago"). Money right-aligned, tabular. Row actions (⋯) appear on hover, always on touch.
- **Footer** (padding 12 20): "Showing 1–10 of 248" in Footnote `--fg-subtle` + pagination (32 squares, `--r-sm`, active `--ink` fill).
- Never center-align table content. On phones the table becomes a list: name, status pill, trailing value.

### Forms

- Build forms from grouped lists: label leading, control trailing, or a full-width field when the label is obvious.
- Standalone fields (sign-in, checkout): 36 tall (44 touch), `--r-md`, `--surface`, 1px `--field-border`, Footnote 500 label above. Never the placeholder as the only label. Focus: `--accent` border + focus ring.
- Validation inline: one `--danger` Footnote under the field saying what to fix.
- Settings save instantly. Creating something happens in a sheet with Cancel and the action.

### Drawer (the inspector)

- Opens from the right when a row is selected. 440px wide, floating 12px from the window edges, `--r-xl`, `--surface`, `--shadow-sheet`, light `--scrim` behind.
- Header: avatar 48, name (Title), company + status pill, close icon button.
- A segmented control: Overview · Activity · Deals · Notes.
- Activity timeline: 8px dot in the hue solid, 1px `--line` connector, item in Body, time in Caption `--fg-subtle`.
- Esc and a click outside close it. Focus moves in on open and returns to the row on close.
- On phones it becomes a bottom sheet (28px top corners, up to 88% of the screen height).

### Sheets and dialogs

- **Desktop:** centered panel, 480–560px, `--r-xl`, padding 20, `--canvas` background (rows inside on `--surface`), `--shadow-sheet` over `--scrim`. Title at the top. Bottom right: Cancel (Gray), then the action (Prominent).
- **Phone:** bottom sheet, 28px top corners, a 36×5 grabber, 16px side margins. Header: Cancel (Plain, leading), title (Headline, centered), Done or Add (Plain 600, trailing).
- Esc and a click outside close it; with unsaved changes, ask first.

### Alerts

- Rare: confirm or interrupt only. Centered, 300px, `--r-xl`, `--surface-raised`. Headline title that states the decision, one sentence of consequence, at most two buttons: Cancel and an explicit verb ("Delete Client").

### Menus, popovers, tooltips

- **Menus:** `--surface-raised`, `--r-md`, padding 4, `--shadow-popover`. Items 32 (44 touch), `--r-sm`, hover `--fill`, optional 16px icon, trailing shortcut in `--fg-subtle`, checkmark for the current value. They scale from 0.96 at their trigger.
- **Tooltips:** `--tooltip` fill, white Caption, `--r-sm`, padding 6 10.

### Feedback

- **Inline first:** a saved row shows a checkmark, a new client row expands into the table.
- **Toast:** rare. A capsule at the top center, `--tooltip` fill, white Label, an icon and at most 5 words. 2 seconds. Never stacked.
- **Loading:** keep the old content with a small spinner. First load: static `--fill` blocks, no shimmer. Known-length tasks get a progress bar.
- **Empty state:** centered. A 40px icon in `--fg-subtle` (no circle), Headline, one sentence in `--fg-muted`, one Gray button. "No Clients Found" / "Try a different name or clear the filters." / Clear Filters.
- **Errors:** what happened and what to do, in place.

### Badges

- Unread or pending counts only: a `--danger-fill` capsule with a white count, or an 8px dot when the number doesn't matter. No decorative "New" or "Beta" pills; if something must be marked, a plain word in `--accent-text`.

---

## 9. Charts

- **Header:** Footnote label in `--fg-muted`, the value in Metric (or Metric 2) with its unit smaller in `--fg-muted`, then the delta pill and period. A small segmented control (30D · 90D · 12M) on the trailing side.
- **Line and area:** monotone, 2px `--accent` stroke, no dots. The area fades from accent 18% to transparent, the only gradient allowed. A previous period is 1.5px dashed `--fg-subtle`.
- **Hover or drag:** a 1px vertical rule in `--field-border`, an active dot (5px, `--surface` fill, 2px accent stroke) and a tooltip.
- **Bars:** rounded tops (6px), 20px wide on desktop.
- **Donut:** inner radius 72%, 2° gaps, 4px corner radius, total in the center (Metric 2 + Caption). Legend below: dot · label · count · %.
- **Grid:** horizontal only, 3–4 lines, 1px `--line`, dashed 4 4. No axis lines, no tick lines, ticks in Caption `--fg-subtle`.
- **Chart tooltip:** `--surface-raised`, `--r-md`, `--shadow-popover`, padding 10 12. Label in Caption `--fg-subtle`, value in Label 600 tabular.
- Legend only with two or more series. Every chart has a text summary for screen readers. No 3D, no more than 6 colors.

---

## 10. Summary, not a KPI wall

Don't build a grid of identical KPI cards. Build a summary the way Health does:

1. **One hero metric** that matters most (8 cols): label, Metric, delta, period control and an area chart.
2. **One composition card** beside it (4 cols): a donut or a short ranked list.
3. **Up to three highlight cards** (4 cols each), built as real buttons. Top row: a 16px icon and a Footnote 500 label, both in the hue's `-fg`, and the period trailing in `--fg-subtle`. Then the value in Metric 2 with its unit, and optionally a tiny sparkline or bar. No icon chips. **Each card opens its detail** (or filters the list below).
4. **Then the main list or table.**

On phones: hero, highlights in one column, then the list.

---

## 11. App screens

- **Desktop shell:** sidebar, toolbar and content (§5).
  - **Sidebar:** `--surface`, hairline on the trailing edge, 248px. Wordmark (Headline) at the top, 20px padding. Rows 36px, `--r-sm`, 18px icon + Label, gap 12, `--fg-muted`. Hover `--hover`. Selected: `--accent-soft` fill, `--accent-text` label and icon. Group headers in Footnote `--fg-subtle`, 24px above. User row at the bottom: avatar 32, name (Label), role (Footnote `--fg-subtle`), chevron.
  - **Toolbar:** 64px, transparent at the top, material + hairline once scrolled. Large Title (with an optional Footnote subtitle) on the leading side; search, up to 3 icon buttons and one Prominent button on the trailing side.
- **Phone:** a top bar with the Large Title that shrinks into a centered Headline on scroll, the content (grouped or plain list), and a translucent tab bar with 2–5 tabs (icon + label, selected in `--accent-text`). Detail pages slide in from the right with a back button labeled with the previous title ("‹ Clients"). The main action is a + at the trailing end of the top bar.
- **Detail:** title and 2–3 key facts at the top, then grouped sections. Actions in the toolbar or as rows at the end, the destructive one last and red.
- **Settings:** a "Settings" section in the sidebar, one row per category; each category is a page of grouped sections with the label leading and the control trailing.
- **Create and edit:** in a sheet (§8).

---

## 12. Websites

Same system, more room. The website should feel like a calm, well-lit showroom for the product.

- **Websites stay light.** `color-scheme: light` on `<html>`. At most one dark section (`color-scheme: dark` on that section), with dark screenshots in it.
- **Pastels live inside the product visuals** and small status dots. Never as section backgrounds.
- **Each section makes one point with one visual:** a real screenshot (or a live crop of the real UI), a photo, a short video or one big number. Pricing, FAQ and the closing call to action can be text only; any other section without a visual gets cut.
- **The visual is the star:** at least half the content width, often all of it. Phone screens keep their natural size (360–420px).
- **Vary the arrangement:** visual below centered text, visual beside the text, or one big number (Display, `--font-rounded`, short caption). Never the same arrangement twice in a row; two beside-the-text sections in a row count as the same, even on opposite sides. On phones everything stacks: text, then visual.
- **Hero:** what it is in 8 words or fewer (Display), why it matters in one sentence (Lead, `--fg-muted`), one Prominent button and one Plain link, then the product shown large. Wide visual below the text, tall visual beside it.
- **Backgrounds:** sections alternate `--bg` and `--canvas`, no borders between them. Padding 96–128 desktop, 80 tablet, 64–80 phone.
- **Type:** Display for the hero, Section for section headlines. On desktop the largest headline is at least 3× body. A headline that is a sentence ends with a period; a label like "Pricing" doesn't. Paragraphs ≤ 3 sentences, ≤ 680px.
- **Features:** show the feature (a crop of real UI) with a short title and one sentence. Up to 3 short text columns, no icon tiles.
- **Screenshots:** hairline edge, no shadow, `--r-xl` for large ones, `--r-2xl` for phone screens.
- **Links:** inline links `--accent-text`. Nav links `--fg`, footer links `--fg-muted`; both turn `--accent-text` on hover.
- **Nav:** slim translucent bar, 52px: wordmark leading, up to 5 links, one Small Prominent button trailing. On phones a menu button opens a full-width solid panel of 44px rows.
- **Pricing:** simple columns. Mark the recommended plan with a word in `--accent-text`, not a glow or ribbon.
- **Social proof** only if it's real: quotes with real names in plain type. No logo walls, star ratings or avatar stacks.
- **Footer:** `--canvas`, Footnote and Caption in `--fg-muted`. Link groups first, the legal line last.
- **Motion:** nothing animates on scroll except the nav turning into material. At most one entrance moment, in the hero.

---

## 13. Motion

- Motion explains where something came from, where it went or what changed. Never decoration.
- **Durations:** `--fast` 150ms for press, hover and switches. `--base` 250ms for menus and popovers. `--slow` 400ms for sheets, the drawer and page transitions.
- **Easing:** `--ease` (`cubic-bezier(0.32, 0.72, 0, 1)`) for movement, `ease-out` for fades, color changes linear over 100ms.
- **Patterns:** the drawer slides in from the right; desktop sheets fade and scale from 0.96; phone sheets slide up; menus scale from 0.96 at their trigger; new rows expand and fade in, deleted rows collapse.
- No bounce, no hover lift, no parallax, no scroll reveals, no number count-up, no shimmer.
- CSS transitions over keyframes. With `prefers-reduced-motion`, movement drops and fades stay.

---

## 14. Voice and tone

Clear, simple, friendly, helpful. The tone adjusts to the moment: calm in errors, warmer in a real celebration.

- **Clear first.** Plain words, specific facts: "Payment received", not "Transaction successfully processed".
- **Short.** Say only what this moment needs.
- **Talk to the person:** "you" and "your". "We" only when the company did something.
- **Explicit buttons:** "Delete Client", "Keep Plan". Never "Yes / No". "OK" only to acknowledge.
- **Capitalization:**
  - Title Case for labels and commands: titles, buttons, tabs, segments, menu items, column headers, status pills, short toasts ("New Client", "Link Copied").
  - Sentence case with a period for anything that is a sentence: descriptions, footers, errors, website headlines.
- **Errors:** what happened and what to do, no "Oops", "Sorry" or "Please": "Couldn't save the client. Check your connection and try again."
- **Alerts:** title states the decision ("Delete This Client?"), message gives the consequence ("You can't undo this."), buttons are verbs.
- **Empty states** name what's missing and how to fix it.
- **Website copy:** short sentences, numbers over adjectives, one idea per sentence.
- **Never:** exclamation marks (except a real celebration), emoji, hype words (seamless, unlock, elevate, supercharge, empower, effortless, revolutionize, next-gen, cutting-edge, game-changer, all-in-one, robust, leverage, "in seconds"), slogan triads ("Fast. Secure. Reliable."), fake urgency.
- **Punctuation:** curly quotes and apostrophes (’ “ ”), an ellipsis on commands that open a dialog ("Export…"), an en dash for ranges (09:00–17:00), a non-breaking space between a number and its unit.
- **Mock data** is realistic: real-looking names, companies and amounts. Never lorem ipsum, "John Doe" or "Acme".

---

## 15. Accessibility

- **Contrast:** text ≥ 4.5:1; large text, field edges and control fills ≥ 3:1. The tokens pass; keep it that way.
- Sizes in rem. Layouts survive 200% zoom and longer translations.
- **Keyboard:** everything reachable in a logical order with a visible focus ring (`--focus`). Esc closes, Enter submits, shortcuts are shown in menus.
- **Targets:** 44px on touch, 32px minimum with a mouse.
- **System settings:** respect `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more`. The tokens handle all three.
- **Never color alone:** pills have words, deltas have ▲/▼, chart series have labels.
- Every icon-only button has a label, every meaningful image has alt text, every chart has a text summary.

---

## 16. Never: these read as AI-made

- Gradients on backgrounds, buttons or text. Glows, blobs, noise, neon, glass cards.
- Purple or indigo buttons or brand fills. Lavender stays pastel and means "selected".
- Tailwind's default palette (`slate`, `zinc`, `gray-500`, `#6b7280`, `#e5e7eb`, `blue-600`…).
- A badge pill above the hero headline. Feature grids of icon tile + title + text. Logo walls, star ratings, avatar stacks as social proof.
- KPI walls with "+20.1% from last month" under every card. Icons inside colored circles or squares.
- Cards inside cards. A border and a shadow on the same box. Card drop shadows. Heavy shadows.
- One radius on everything. Hover lift. Fade-up on every section. Count-up numbers. Shimmer.
- All-caps or letter-spaced labels. One word of a headline in another color. Weights above 600.
- Saturated status pills (pure green or red). Centered table content.
- Emoji as icons. "→" in buttons. Lorem ipsum, "John Doe", "Acme".
- Centering everything. More than one accent.

---

## 17. Tokens and text styles

Copy into a global stylesheet (`tokens.css`). App pages put `class="app"` on `<body>`; websites don't, and set `color-scheme: light` on `<html>`.

```css
:root {
  color-scheme: light dark;

  /* Type */
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", system-ui, sans-serif;
  --font-display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter Variable", "Inter", system-ui, sans-serif;
  --font-rounded: ui-rounded, "SF Pro Rounded", var(--font-display);

  /* Neutrals */
  --canvas: light-dark(#F5F6F8, #000000);
  --bg: light-dark(#FFFFFF, #000000);
  --surface: light-dark(#FFFFFF, #1C1C1E);
  --surface-raised: light-dark(#FFFFFF, #2C2C2E);
  --fill: light-dark(rgb(116 122 140 / 0.10), rgb(118 118 128 / 0.24));
  --hover: light-dark(rgb(16 24 40 / 0.03), rgb(255 255 255 / 0.05));
  --line: light-dark(#E7E9ED, #2E2E32);
  --field-border: light-dark(#8E9099, #6C6C72);
  --fg: light-dark(#16181D, #F5F5F7);
  --fg-muted: light-dark(#4E5361, #AEAEB2);
  --fg-subtle: light-dark(#6A7080, #98989D);
  --fg-disabled: light-dark(#AEB2BB, #5A5A5F);

  /* Ink = do */
  --ink: light-dark(#1E222B, #F5F5F7);
  --ink-hover: light-dark(#2B303B, #E3E3E8);
  --on-ink: light-dark(#FFFFFF, #16181D);

  /* Lavender = here */
  --accent: #8E88F2;
  --accent-soft: light-dark(#EEEDFD, #333248);
  --accent-text: light-dark(#4C46B6, #BDB9FF);
  --focus: 0 0 0 3px color-mix(in srgb, var(--accent) 50%, transparent);

  /* Pastels: soft / solid / fg */
  --lavender-soft: light-dark(#EEEDFD, #333248); --lavender: #8E88F2; --lavender-fg: light-dark(#4C46B6, #BDB9FF);
  --mint-soft:     light-dark(#E4F5ED, #2C3E38); --mint:     #6CC49F; --mint-fg:     light-dark(#1E7752, #8EDDB9);
  --sky-soft:      light-dark(#E5F1FC, #2F3B47); --sky:      #7DB5E9; --sky-fg:      light-dark(#28649A, #9DCBF5);
  --peach-soft:    light-dark(#FDEEE5, #473831); --peach:    #F2A67F; --peach-fg:    light-dark(#A4502A, #F9BE9E);
  --butter-soft:   light-dark(#FBF4DD, #443E2B); --butter:   #E6C65E; --butter-fg:   light-dark(#876712, #EDD484);
  --rose-soft:     light-dark(#FCE9ED, #46353A); --rose:     #EE98A9; --rose-fg:     light-dark(#A23A52, #F7B3C1);

  /* Status */
  --danger: light-dark(#CC3B3B, #FF6B63);
  --danger-fill: #CC3B3B;

  /* Floating */
  --tooltip: light-dark(#1E222B, #3A3A3C);
  --material: color-mix(in srgb, var(--surface) 78%, transparent);
  --blur: saturate(180%) blur(20px);
  --scrim: light-dark(rgb(22 24 29 / 0.28), rgb(0 0 0 / 0.5));
  --shadow-control: 0 1px 3px light-dark(rgb(16 24 40 / 0.12), rgb(0 0 0 / 0.4)), 0 0 0 0.5px light-dark(rgb(16 24 40 / 0.06), rgb(255 255 255 / 0.08));
  --shadow-popover: 0 12px 32px -8px light-dark(rgb(16 24 40 / 0.16), rgb(0 0 0 / 0.6)), 0 0 0 0.5px light-dark(rgb(16 24 40 / 0.08), rgb(255 255 255 / 0.12));
  --shadow-sheet: 0 24px 64px -12px light-dark(rgb(16 24 40 / 0.24), rgb(0 0 0 / 0.7)), 0 0 0 0.5px light-dark(rgb(16 24 40 / 0.08), rgb(255 255 255 / 0.12));
  --hairline: 1px;

  /* Shape */
  --r-xs: 6px;
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 16px;
  --r-xl: 20px;
  --r-2xl: 28px;
  --r-full: 999px;

  /* Motion */
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
  --fast: 150ms;
  --base: 250ms;
  --slow: 400ms;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
@media (min-resolution: 2dppx) { :root { --hairline: 0.5px; } }
@media (prefers-contrast: more) {
  :root {
    --fg-muted: light-dark(#363A44, #D1D1D6);
    --fg-subtle: light-dark(#4E5361, #AEAEB2);
    --line: light-dark(#B9BDC6, #48484E);
    --fill: light-dark(rgb(116 122 140 / 0.2), rgb(118 118 128 / 0.4));
  }
}

body {
  margin: 0;
  font: 400 17px/22px var(--font);
  font-feature-settings: "cv11", "ss01";
  letter-spacing: -0.01em;
  color: var(--fg);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  font-optical-sizing: auto;
}
body.app { background: var(--canvas); }
:where(h1, h2, h3, h4, h5, h6, p) { margin: 0; font-size: inherit; font-weight: inherit; }
:focus-visible { outline: 2px solid transparent; box-shadow: var(--focus); }

/* Text styles: touch and website */
.t-large-title { font: 600 34px/41px var(--font-display); letter-spacing: -0.02em; }
.t-title       { font: 600 22px/28px var(--font-display); letter-spacing: -0.015em; }
.t-headline    { font: 600 17px/22px var(--font); letter-spacing: -0.01em; }
.t-body        { font: 400 17px/22px var(--font); letter-spacing: -0.01em; }
.t-label       { font: 500 15px/20px var(--font); letter-spacing: -0.005em; }
.t-subheadline { font: 400 15px/20px var(--font); letter-spacing: -0.005em; }
.t-footnote    { font: 400 13px/18px var(--font); letter-spacing: 0; }
.t-caption     { font: 400 12px/16px var(--font); letter-spacing: 0; }
.t-metric      { font: 600 40px/48px var(--font-rounded); letter-spacing: -0.025em; }
.t-metric-2    { font: 600 28px/34px var(--font-rounded); letter-spacing: -0.02em; }
.t-display     { font: 600 64px/68px var(--font-display); letter-spacing: -0.03em; }
.t-section     { font: 600 40px/44px var(--font-display); letter-spacing: -0.025em; }
.t-lead        { font: 400 21px/30px var(--font-display); letter-spacing: -0.01em; }
.num           { font-variant-numeric: tabular-nums; }

@media (max-width: 743px) {
  .t-display { font-size: 40px; line-height: 44px; }
  .t-section { font-size: 28px; line-height: 34px; }
  .t-lead    { font-size: 19px; line-height: 27px; }
}
/* Desktop app density */
@media (min-width: 1024px) and (pointer: fine) {
  body.app            { font-size: 14px; line-height: 20px; }
  .app .t-large-title { font-size: 24px; line-height: 30px; }
  .app .t-title       { font-size: 18px; line-height: 24px; }
  .app .t-headline    { font-size: 15px; line-height: 20px; }
  .app .t-body        { font-size: 14px; line-height: 20px; }
  .app .t-label       { font-size: 13px; line-height: 18px; }
  .app .t-subheadline { font-size: 13px; line-height: 18px; }
  .app .t-footnote    { font-size: 12px; line-height: 16px; }
  .app .t-caption     { font-size: 11px; line-height: 14px; }
  .app .t-metric      { font-size: 34px; line-height: 40px; }
  .app .t-metric-2    { font-size: 24px; line-height: 30px; }
}

/* Translucent bars */
.material { background: var(--material); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); }
@media (prefers-reduced-transparency: reduce) {
  .material { background: var(--surface); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
/* Reduced motion: keep fades and color, drop movement */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-property: opacity, color, background-color, border-color, box-shadow !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
}
```

`light-dark()` picks the value from the element's `color-scheme`. That's why `color-scheme: dark` on one website section turns that section dark, and why `data-theme` on `<html>` overrides the system.

---

## 18. Tailwind v4 and code helpers

Remove Tailwind's defaults so the classes behind the AI look don't exist, then map the tokens.

```css
@import "tailwindcss";
@import "@fontsource-variable/inter/opsz.css";
@import "./tokens.css";

@theme {
  --color-*: initial;
  --shadow-*: initial;
  --radius-*: initial;
  --font-weight-*: initial;
  --text-*: initial;                 /* sizes come from the t-* classes */
  --breakpoint-*: initial;

  --breakpoint-tablet: 744px;
  --breakpoint-desktop: 1024px;
  --breakpoint-wide: 1440px;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --radius-xs: 6px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;
  --radius-2xl: 28px;
  --radius-full: 999px;
}
@theme inline {
  --font-sans: var(--font);
  --color-canvas: var(--canvas);
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-raised: var(--surface-raised);
  --color-fill: var(--fill);
  --color-hover: var(--hover);
  --color-line: var(--line);
  --color-field: var(--field-border);
  --color-fg: var(--fg);
  --color-fg-muted: var(--fg-muted);
  --color-fg-subtle: var(--fg-subtle);
  --color-fg-disabled: var(--fg-disabled);
  --color-ink: var(--ink);
  --color-ink-hover: var(--ink-hover);
  --color-on-ink: var(--on-ink);
  --color-accent: var(--accent);
  --color-accent-soft: var(--accent-soft);
  --color-accent-text: var(--accent-text);
  --color-danger: var(--danger);
  --color-danger-fill: var(--danger-fill);
  --color-tooltip: var(--tooltip);
  --color-lavender: var(--lavender);  --color-lavender-soft: var(--lavender-soft);  --color-lavender-fg: var(--lavender-fg);
  --color-mint: var(--mint);          --color-mint-soft: var(--mint-soft);          --color-mint-fg: var(--mint-fg);
  --color-sky: var(--sky);            --color-sky-soft: var(--sky-soft);            --color-sky-fg: var(--sky-fg);
  --color-peach: var(--peach);        --color-peach-soft: var(--peach-soft);        --color-peach-fg: var(--peach-fg);
  --color-butter: var(--butter);      --color-butter-soft: var(--butter-soft);      --color-butter-fg: var(--butter-fg);
  --color-rose: var(--rose);          --color-rose-soft: var(--rose-soft);          --color-rose-fg: var(--rose-fg);
  --color-white: #fff;
  --color-transparent: transparent;
  --color-current: currentColor;
  --shadow-control: var(--shadow-control);
  --shadow-menu: var(--shadow-popover);   /* different names so variables don't reference themselves */
  --shadow-panel: var(--shadow-sheet);
}
```

Usage: `bg-surface border border-line rounded-lg`, `text-fg-muted`, `bg-mint-soft text-mint-fg`, `shadow-menu`. Use the `t-*` classes for all text and only spacing steps from §5.

**shadcn/ui:** keep its behavior, replace its look. Restyle every component to these specs (capsule buttons, grouped lists, these radii and colors) and delete its default theme variables.

**Status map (`lib/status.ts`)**

```ts
export const STATUS = {
  new:      { label: "New Lead",        pill: "bg-sky-soft text-sky-fg",           dot: "bg-sky" },
  active:   { label: "Active",          pill: "bg-mint-soft text-mint-fg",         dot: "bg-mint" },
  engaged:  { label: "In Negotiation",  pill: "bg-lavender-soft text-lavender-fg", dot: "bg-lavender" },
  followup: { label: "Needs Follow-Up", pill: "bg-butter-soft text-butter-fg",     dot: "bg-butter" },
  atRisk:   { label: "At Risk",         pill: "bg-peach-soft text-peach-fg",       dot: "bg-peach" },
  inactive: { label: "Inactive",        pill: "bg-fill text-fg-muted",             dot: "bg-fg-disabled" },
} as const;

export type ClientStatus = keyof typeof STATUS;

export const engagementColor = (score: number) =>
  score >= 70 ? "bg-mint" : score >= 40 ? "bg-butter" : "bg-peach";

export const CHART_COLORS = ["#8E88F2", "#6CC49F", "#7DB5E9", "#F2A67F", "#E6C65E", "#EE98A9"];
```

---

## 19. Before you ship

1. Squint: one thing leads each screen and each section.
2. Only neutrals, ink, the one accent and pastels-with-meaning appear.
3. Ink is on actions only. Lavender is on selected, focused and "on" things only.
4. Only weights 400, 500 and 600.
5. Only tokens: no invented sizes, colors, radii or shadows.
6. Edges align, separators are inset to the text, corners nest.
7. Every state exists: empty, loading, error, long text.
8. Phone and desktop each get their own pattern: tab bar or sidebar, bottom sheet or centered sheet. On websites, no two sections in a row share an arrangement.
9. Dark mode is checked, translucent bars fall back to solid.
10. Copy has Title Case labels, sentence-case sentences, explicit buttons and no banned words.
11. Take one thing away. If nothing is lost, leave it out.

---

## 20. Build prompt (copy into Claude Code, Cursor or v0)

```
Read DESIGN.md fully before writing any code and follow it strictly. It is the only
source for colors, type, spacing, radius, shadows, motion, copy and component styles.

Stack: Next.js (App Router) + TypeScript + Tailwind CSS v4 (mapped per §18) +
shadcn/ui restyled to DESIGN.md + Recharts + lucide-react. Load Inter with optical sizes.

Build in this order and check each step against DESIGN.md before moving on:
1. Tokens: §17 into app/tokens.css, §18 into app/globals.css and lib/status.ts.
2. Primitives: Card, Button (Prominent/Tinted/Gray/Plain/Destructive), IconButton,
   Search, SegmentedControl, FilterChip, StatusPill, Delta, Avatar, Switch, Pagination,
   Tooltip, Toast.
3. App shell: Sidebar, Toolbar (material on scroll), tab bar under 1024px.
4. Overview page as a summary (§10): hero metric with area chart, status donut,
   three highlight cards that filter the table, then the clients table with toolbar,
   pagination, empty state, the drawer on row click and an Add Client sheet.
5. Mock data: 40 realistic clients (name, email, company, owner, status, engagement
   0–100, last contact, deal value) and 12 months of pipeline data.
6. Dark mode with a manual override.

Rules:
- No values outside DESIGN.md. No Tailwind default palette.
- Follow §14 voice, §15 accessibility and §16 never-list.
- If something isn't specified, pick the quietest option and note it.
- Server components by default; client components only where interaction needs it.

When done, list every place you deviated from DESIGN.md and why.
```
