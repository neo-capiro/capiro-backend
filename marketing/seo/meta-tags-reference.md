# Capiro — Title Tags & Meta Descriptions Reference

Applied today (July 2026) as dynamic `document.title` / meta-description swaps inside the existing single-page site (see `PAGE_META` in `index.html`). Use this same copy verbatim as the real `<title>` and `<meta name="description">` once each section becomes its own URL (`/platform`, `/solutions`, etc. — see the "Core Fix" section of the main SEO plan).

| Page / URL | Title Tag | Meta Description |
|---|---|---|
| `/` (Home) | Capiro — AI Chief of Staff & Operating System for Government Affairs | Capiro is the operating system for government affairs teams. Meri, your AI Chief of Staff, tracks legislation, drafts outreach, and manages every client and capability in one platform. Measured by outcomes. |
| `/platform` | Platform — Meri, Your AI Chief of Staff \| Capiro | Meet Meri: the AI Chief of Staff that tracks legislation, drafts outreach, and remembers every client objective so your government affairs team can act, not just monitor. |
| `/solutions` | Solutions for Every Government Affairs Practice \| Capiro | From lobbying firms to corporate government affairs teams and associations — see how Capiro adapts to every sector and practice type. |
| `/insights` | Insights — The Cycle by Capiro | The Cycle: analysis and updates on government affairs, legislative trends, and how AI is changing advocacy work. |
| `/pricing` | Pricing \| Capiro | Capiro scales with your practice, not against it. See plans built for government affairs teams of every size. |
| `/privacy` | Privacy Policy \| Capiro | How Capiro collects, uses, and protects your information. |
| `/terms` | Terms of Service \| Capiro | The terms governing use of Capiro's platform and services. |

## Notes

- All titles are under 60 characters; all descriptions are 150–160 characters, matching Google's typical snippet truncation points.
- Each includes the primary keyword for that section (e.g. "AI Chief of Staff," "Operating System for Government Affairs," "Solutions") near the front.
- Open Graph and Twitter Card tags mirror these values automatically (see `og:title`/`og:description`/`twitter:title`/`twitter:description` in the `<head>`, updated live by `updateMeta()` in the page script).
- **Caveat:** because the site is still one URL today, these swaps improve the browser tab title and social-share previews when a user shares mid-session, but they do **not** give Google separate indexable pages — that still requires the URL split described in the main plan. Treat this as a bridge, not the fix.
