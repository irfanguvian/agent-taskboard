# Taskboard: project rules

## UI work

Before any UI work, read design/DESIGN.md, import design/foundation.css, and match design/reference-landing.html (marketing) or design/reference-app.html (app UI).

In this repo:
- The board UI is `ui/`: vanilla HTML, CSS and JS, no build step. CSS loads in this order: `/foundation.css`, then `/style.css` (shell, today, reminders), then `/flows.css` (flows table, flow inspector).
- `ui/foundation.css` is a symlink to `design/foundation.css`. Edit the design copy only. Never copy tokens into app CSS.
- The CSP is `default-src 'self'`: no CDN fonts or scripts. Fonts come from the foundation's system stack (SF on a Mac); Inter is not loaded.
- A new UI asset file needs its name in `TYPES`, `PUBLIC` and the asset route in `lib/http.js`.
- `ui/app.js` builds DOM with `el()` and `textContent` only, never `innerHTML` (`test/ui-xss.test.js` enforces this).
- `<body class="app">` turns on the desktop app density (DESIGN.md §17). Shared parts (buttons, pills, cards, table, sheet, drawer, toasts) live in the foundation; app CSS only lays them out.
- Icons are lucide paths drawn by `icon(name)` in `ui/app.js` (the `ICONS` map), never icon files or a CDN.
- The lavish clarify page (`lib/interview.js`) is served from another origin, so it inlines `design/foundation.css` (read once, cached) plus a small token-only CSS.
