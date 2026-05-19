# georgian fonts workshop

Two modes:
- **/** — browse all workshop fonts. Each card shows the font name (set in its own typeface), an editable sample line, the full Georgian alphabet, size buttons, and a download link.
- **/cascade** — type any letter and a giant glyph in a random workshop font tumbles down the screen with bouncing physics. Backspace removes the last one.

## Adding fonts

Drop `.ttf`, `.otf`, `.woff`, or `.woff2` files into `public/fonts/`. They're auto-discovered on the next request — no config to update.

Filename conventions:
- `Font Name.ttf` → displayed as "Font Name"
- `Font Name__Designer Name.ttf` → displayed as "Font Name" by "Designer Name"

Underscores and hyphens in the filename are converted to spaces in the display name.

## Dev

```
npm run dev
```

Runs on the port configured in `.claude/launch.json` (8095) when launched via the preview tool.
