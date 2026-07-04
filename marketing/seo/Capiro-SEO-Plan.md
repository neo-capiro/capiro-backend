# Capiro SEO Plan
*Prepared July 3, 2026 — based on a direct audit of `marketing/index.html` and the live competitive landscape for government affairs software.*

## Executive Summary

Capiro.ai currently has **zero organic search footprint** — the domain returns no indexed results at all. That's not a ranking problem, it's a foundation problem: the entire site is one static HTML file with no meta description, no Open Graph tags, no sitemap, no robots.txt, and — most importantly — **no separate URLs for anything**. "Platform," "Solutions," "Pricing," "Insights," even Privacy and Terms are all just hidden `<div>`s toggled by JavaScript on a single page (nginx is configured to 404 anything that isn't `/`). Google can only ever index and rank one page for the whole product line, which means Capiro can't compete for any of the specific terms buyers actually search (e.g. "legislative tracking software," "AI for government affairs," "lobbying CRM").

The good news: the copy itself is strong, differentiated, and keyword-relevant ("Operating System for Government Affairs," "AI Chief of Staff"), and competitors (Quorum, FiscalNote, BGOV, LegiStorm) largely win on content volume and domain age rather than technical sophistication — so there's real room to compete. The three highest-impact priorities, in order: **(1) split the single page into real, crawlable URLs, (2) add basic on-page metadata and a sitemap/robots.txt so Google can index it at all, and (3) bring "The Cycle" content in-house** instead of publishing it on Substack, where all the SEO value currently leaks to a domain Capiro doesn't own.

Overall assessment: **critical issues** — this is pre-indexing, not underperforming. Fixing the architecture and metadata gaps should be treated as a prerequisite to any keyword or content investment.

## Technical SEO Checklist

| Check | Status | Details |
|---|---|---|
| Indexed in Google | **Fail** | `site:capiro.ai` returns no results. Domain appears un-submitted / unindexed. |
| Unique URLs per page | **Fail** | Single `index.html`; "pages" are JS-toggled `<div>` sections via `onclick="showPage(...)"`, no `href`, no `history.pushState`. Nginx has no SPA fallback — any real path 404s. |
| Title tag | **Fail** | One static title for the entire site: "Capiro — The Operating System for Government Affairs." Same title shows for Pricing, Privacy, Terms, everything. |
| Meta description | **Fail** | Not present anywhere in `<head>`. |
| Open Graph / Twitter Card tags | **Fail** | None present — link previews in Slack/LinkedIn/X will show blank or broken. |
| Canonical tags | **Fail** | None present. |
| robots.txt | **Fail** | Does not exist. |
| XML sitemap | **Fail** | Does not exist. |
| Structured data (schema.org) | **Fail** | No JSON-LD anywhere (no Organization, SoftwareApplication, or FAQ schema). |
| H1 hierarchy | **Warning** | 7 separate `<h1>` tags exist in the same DOM (Home, Meri, Practice, Cycle, Scale, Privacy, Terms) since all "pages" are always in the document. Confuses which heading represents the page. |
| HTTPS | **Pass** | Enforced via HSTS header in nginx config. |
| Security headers | **Pass** | X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy all set. |
| Gzip compression | **Pass** | Enabled for text/JS/CSS/SVG in nginx. |
| Image alt text | **Pass (mostly)** | Content screenshots have descriptive alt text (e.g. "Congressional Directory," "Engagement Manager"). |
| Page weight / Core Web Vitals risk | **Warning** | Hero section autoplays a 1.4MB `hero.mp4` on load (`preload="auto"`) on every visit, including mobile — will hurt LCP. |
| Unused assets | **Low** | `final.mp4` (12MB), `capitol-west-front.jpg`, and `member-directory.png` are in `/assets/` but not referenced anywhere in the HTML — safe to remove from the deploy. |
| Blog/content domain | **Fail** | "The Cycle" newsletter lives entirely on `capirohq.substack.com`. All backlinks, freshness signals, and long-tail keyword rankings from that content accrue to Substack's domain, not capiro.ai. |
| Language declaration | **Pass** | `<html lang="en">` present. |

## The Core Fix: Give Capiro Real URLs

This is the prerequisite for everything else. Recommended URL structure, mapped from the existing "pages" already written in the HTML:

| Current JS "page" | Recommended URL | Primary keyword target |
|---|---|---|
| `page-home` | `/` | government affairs software, operating system for government affairs |
| `page-platform` | `/platform` (or split further, see below) | AI chief of staff government affairs, legislative tracking software |
| `page-solutions` | `/solutions` or `/solutions/[industry]` | government affairs software for [industry/sector] |
| `page-pricing` | `/pricing` | government affairs software pricing |
| `page-insights` | `/insights` (migrate off Substack, or at minimum mirror/canonical) | government affairs trends, policy tracking guides |
| `page-privacy` | `/privacy` | — |
| `page-terms` | `/terms` | — |

Each should be its own server-rendered (or at minimum statically pre-rendered) HTML document with its own `<title>`, meta description, canonical tag, and single `<h1>`. The visual design and copy can stay exactly as-is — this is an information-architecture change, not a redesign. Given the current stack is static nginx, the simplest path is pre-rendering each section as its own static HTML file at build time (or a lightweight static site generator), keeping the JS-toggle behavior only as a progressive enhancement for same-page anchor jumps.

## Keyword Opportunities

Based on the live competitive landscape (Quorum, FiscalNote/PolicyNote, BGOV, LegiStorm, Plural Policy, USLege all compete here) and Capiro's actual positioning in the copy:

| Keyword | Est. Difficulty | Opportunity | Intent | Recommended Page/Content |
|---|---|---|---|---|
| government affairs software | Hard | Medium | Commercial | Homepage |
| government affairs platform | Hard | Medium | Commercial | Homepage |
| AI chief of staff for government affairs | Easy | High | Commercial | `/platform` (Meri) |
| legislative tracking software | Hard | Medium | Commercial | `/platform` |
| lobbying software | Hard | Medium | Commercial | `/platform` or comparison page |
| lobbying CRM | Moderate | High | Commercial | `/platform` |
| advocacy management software | Moderate | High | Commercial | `/solutions` |
| government relations software | Moderate | High | Commercial | Homepage |
| public affairs software | Hard | Medium | Commercial | Homepage |
| government affairs software for [sector, e.g. healthcare/energy] | Easy | High | Commercial | `/solutions/[sector]` pages |
| best government affairs software 2026 | Hard | Medium | Commercial investigation | Comparison/listicle-bait content |
| Quorum alternative | Moderate | High | Commercial investigation | `/vs/quorum` comparison page |
| FiscalNote alternative | Moderate | High | Commercial investigation | `/vs/fiscalnote` comparison page |
| AI for government affairs | Moderate | High | Informational/commercial | `/insights` pillar page |
| how to track state legislation | Easy | Medium | Informational | `/insights` guide |
| legislative session tracking tool | Easy | Medium | Commercial | `/platform` |
| congressional staff directory software | Moderate | Medium | Commercial | `/platform` (references "14,344 staffers") |
| grassroots advocacy software | Moderate | Medium | Commercial | `/solutions` |
| government affairs automation | Easy | High | Commercial | `/platform` |
| AI legislative tracking | Moderate | High | Commercial | `/platform` |
| government affairs software for lobbying firms | Easy | High | Commercial | `/solutions` |
| government affairs software for associations | Easy | High | Commercial | `/solutions` |
| government affairs software for corporations | Easy | High | Commercial | `/solutions` |
| what does a government affairs team do | Easy | Low | Informational (top of funnel) | `/insights` |
| government affairs KPIs / measuring advocacy outcomes | Easy | Medium | Informational | `/insights` (ties to "Measured by outcomes" positioning) |

## On-Page Issues

| Page/Section | Issue | Severity | Fix |
|---|---|---|---|
| All pages | No meta description | Critical | Write a unique 150–160 character description per page, matching that page's copy. |
| All pages | Shared, non-unique `<title>` | Critical | Unique title per page, 50–60 characters, primary keyword near the front (e.g. "AI Chief of Staff for Government Affairs \| Capiro"). |
| All pages | No canonical tag | Critical | Add `<link rel="canonical">` once each section becomes its own URL. |
| All pages | No Open Graph/Twitter tags | High | Add `og:title`, `og:description`, `og:image` (use `hero-poster.jpg` or a dedicated share image), `twitter:card`. |
| Whole document | 7 `<h1>` tags in one DOM | Medium | Once pages are split, each document should have exactly one `<h1>`. |
| Homepage | Hero video autoplays 1.4MB file on every load | Medium | Compress further or lazy-load below-the-fold; consider serving a static poster on mobile/slow connections. |
| `/insights` equivalent | Content lives off-domain on Substack | High | Republish or canonical-mirror posts on `capiro.ai/insights` so the content builds Capiro's own domain authority. |
| Deploy/assets | `final.mp4` (12MB), 2 unused images | Low | Remove from the build to shrink deploy size (not currently downloaded by visitors, but worth cleaning up). |

## Content Gap Recommendations

| Topic/Format | Why it matters | Priority | Effort |
|---|---|---|---|
| Comparison pages (`vs. Quorum`, `vs. FiscalNote`, `vs. BGOV`) | Every major competitor listicle (Pursuit, LegiStorm, ZipDo) ranks for "best government affairs software" — Capiro isn't in any of them yet. Direct comparison pages capture "alternative to X" searches immediately. | High | Moderate (half day each) |
| In-house blog/insights section | "The Cycle" already exists as content but lives on Substack. Migrating or mirroring it to `/insights` is the single biggest content-side lever available. | High | Moderate (infrastructure) then ongoing |
| Sector/solution landing pages | Homepage mentions "every sector, one platform" but there's no dedicated page per vertical (e.g. healthcare, energy, tech) that a niche buyer would find via search. | High | Moderate (1 page per sector) |
| Glossary / "what is government affairs software" style pillar page | Competitors (Quorum, FiscalNote) publish heavily on definitional and how-to content that captures top-of-funnel traffic. Capiro has none. | Medium | Substantial |
| Case studies / outcomes content | Site repeats "Measured by outcomes" as a tagline three times but has no proof content (case studies, benchmarks) — this is also a content and credibility gap, not just SEO. | Medium | Substantial |
| Organization + SoftwareApplication schema markup | No structured data currently; this affects rich result eligibility once pages are indexed. | Medium | Quick win |

## Competitor Snapshot

| Dimension | Capiro | Quorum | FiscalNote |
|---|---|---|---|
| Indexed pages | ~0 (unindexed) | Hundreds+ | Hundreds+ |
| Dedicated blog/resource hub | Off-domain (Substack) | On-domain, active | On-domain, active |
| Comparison/alternative pages | None | Yes (targets FiscalNote directly) | Yes (targets Quorum directly) |
| Structured data | None | Likely present | Likely present |
| Domain authority signal | New/unindexed | Established | Established |
| Differentiated positioning | Strong (AI Chief of Staff, "Meri") | Broad platform | Broad platform + news arm (CQ) |

Capiro's disadvantage right now is entirely technical/structural, not positioning — the copy and product story are more distinctive than the incumbents'. Closing the indexation gap is what unlocks that advantage.

## Prioritized Action Plan

**Quick wins (this week):**
- Write and add a unique `<title>` and meta description to the homepage at minimum (highest-traffic entry point).
- Create and publish `robots.txt` and an XML sitemap (even a 1-URL sitemap is better than none).
- Add Open Graph and Twitter Card tags so shared links render properly.
- Submit the domain to Google Search Console and Bing Webmaster Tools.
- Add `Organization` and `SoftwareApplication` JSON-LD schema to the homepage.
- Remove unused assets (`final.mp4`, `capitol-west-front.jpg`, `member-directory.png`) from the deploy.
- Compress or defer the autoplay hero video for mobile.

**Strategic investments (this quarter):**
- Re-architect the site so Platform, Solutions, Pricing, and Insights each get a real, indexable URL with unique metadata (the core fix above). This unblocks every keyword-targeting effort that follows.
- Migrate or mirror "The Cycle" content to `capiro.ai/insights` so content marketing builds Capiro's own domain authority instead of Substack's.
- Publish 2–3 comparison pages (`/vs/quorum`, `/vs/fiscalnote`) targeting "alternative" and "vs." searches.
- Build 2–3 sector-specific solution pages for the verticals Capiro already serves.
- Get listed in the existing "best government affairs software" roundup articles (Pursuit, LegiStorm, ZipDo) — outreach to those publishers now that there will be real pages to link to.

**Longer-term (next 2–3 quarters):**
- Build out a pillar/cluster content strategy around "government affairs software," "AI for government affairs," and "legislative tracking" with supporting how-to and definitional content.
- Publish outcomes-focused case studies to support the "Measured by outcomes" positioning and generate link-worthy, citable content.
- Pursue backlinks from government affairs associations, industry press, and podcasts/newsletters in the policy space.

## Next Steps

I can help with any of the following:
- Draft the actual title tags, meta descriptions, and OG tags for each page.
- Write a content brief for the first comparison page (e.g. Capiro vs. Quorum).
- Draft `robots.txt` and a starter `sitemap.xml`.
- Draft JSON-LD schema for the homepage.

Just let me know which to tackle first.
