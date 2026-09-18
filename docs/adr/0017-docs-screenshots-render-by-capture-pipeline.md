# Docs screenshots render by capture pipeline

The docs show each extension's UI as screenshots, but pi is a terminal app:
live data, logins, and transient notifications mean a hand-taken image rots
without anyone noticing. So no Screenshot is ever taken by hand. A Capture
script renders every Screenshot from the extension's real UI code with
committed Fixture data, captures the real terminal for the surfaces where
the terminal is the product (CLI output, pi's persistent notifications),
pins the terminal look (grid size, theme, font), and a CI job re-renders
and fails when a committed Screenshot no longer matches.

## Considered options

- **Hand-taken terminal screenshots.** Simplest, but the quota numbers are
  live, some UI is transient, and nothing detects staleness.
- **Off-screen rendering only.** Covers the TUI views, but not the real
  terminal surfaces (CLI output, pi's own chrome).
- **Terminal screencast tooling (VHS family).** A real terminal emulator,
  but a fixed built-in font, so the shot cannot match the user's terminal.
- **Browser rendering (Playwright + xterm.js).** Most WYSIWYG, but a browser
  download in the repo to rasterize static text.

## Consequences

- The terminal font TTF and golden PNG files are checked into the repo, and
  the render pins grid size, theme, and font, so local and CI renders are
  byte-identical.
- The font pin is exact at the rasterizer boundary: the SVG font-family is
  the family name inside the committed TTFs' name tables, resvg loads only
  the committed file paths with system fonts disabled, and the theme color
  mode is pinned by environment (COLORTERM) before pi's theme loader runs.
  A golden test proves the committed TTFs are what rasterizes: the same
  screen rendered without the font files must differ.
- The real-pi captures run with stub `fd` and `rg` binaries on PATH so pi's
  "not found" startup warnings - which depend on what the rendering machine
  has installed - never reach the screen.
- Adding a Screenshot is a Capture definition (extension, view, capture
  method, fixture); the pipeline does not change.
- A UI change that alters a view's appearance is a capture re-run, and CI
  fails until the image is updated.
