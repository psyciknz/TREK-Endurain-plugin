# Endurain Import Style Guide

The activity picker follows the visual language in `transport-serch-client.html` and uses TREK's theme tokens so light/dark mode and host accents stay in sync.

## Typography

- Use Poppins first, then the platform system sans-serif stack.
- Body text is 14px with a 1.5 line height; activity metadata and field labels are 12px.
- Keep headings compact: 23px for the page title and 13px for activity names.

## Color Tokens

| Role | Token | Light reference | Dark reference |
|---|---|---|---|
| Main surface | `--bg-primary` | `#ffffff` | `#121215` |
| Raised surface | `--bg-card` | `#ffffff` | `#131316` |
| Secondary surface | `--bg-secondary` | `#f8fafc` | `#1a1a1e` |
| Primary text | `--text-primary` | `#111827` | `#f4f4f5` |
| Secondary text | `--text-muted` | `#6b7280` | `#a1a1aa` |
| Action | `--accent` | `#111827` | `#e4e4e7` |
| Action text | `--accent-text` | `#ffffff` | `#09090b` |
| Success | `--success` | `#16a34a` | `#22c55e` |
| Error | `--danger` | `#dc2626` | `#ef4444` |

Use tokens rather than hard-coded colors in components. The host may override token values for its active theme and accent.

## Controls

- Primary actions such as Search and Import use primary text as the fill and the main surface as text (near-black in light mode, contrast-safe in dark mode).
- Secondary actions such as Refresh use the secondary surface, primary text, and a primary-border outline.
- Select all uses the transparent ghost treatment.
- Inputs use the input surface, primary border, 10px corners, and an accent focus ring.
- Repeated activity rows use the card surface, a subtle border, 16px corners, and a restrained hover border/shadow.
- Disabled controls use 50% opacity and a not-allowed cursor.