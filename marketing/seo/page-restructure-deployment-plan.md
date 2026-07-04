# Capiro Marketing Site — Multi-Page Restructure: Deployment Plan

Handoff spec for implementation. Written after direct inspection of `marketing/index.html`, `marketing/nginx/nginx.conf`, `marketing/Dockerfile`, and `marketing/deploy.sh`.

## Goal

Convert the marketing site from one static HTML file with JS-toggled "pages" into a true multi-page static site: every section becomes a real, independently crawlable, indexable URL with its own title, meta description, canonical tag, and single `<h1>` — with zero visual or copy changes.

## Current architecture (context for the implementer)

- `marketing/index.html` — one file containing 7 `<div class="page" id="page-X">` sections: `home`, `platform`, `solutions`, `insights`, `pricing`, `privacy`, `terms`. A `showPage(id)` JS function toggles an `.active` class to show/hide them. Nav links use `onclick="showPage('x')"`, not real `href` attributes.
- All CSS lives in one inline `<style>` block in `<head>`. All behavior JS lives in one inline `<script>` at the end of `<body>`.
- Shared chrome across all "pages": `<nav>` header, footer (with Privacy/Terms links), and the demo-request modal (`#demoModal`).
- A prior pass already added per-document `<head>` metadata (meta description, canonical, OG/Twitter tags, JSON-LD) plus a `PAGE_META` table and `updateMeta()` function that swap `document.title`/description client-side when `showPage()` runs. **This was an explicit stop-gap** — it improves the browser tab and mid-session social shares but does not give Google separate indexable URLs. It should be removed once real pages exist.
- `marketing/nginx/nginx.conf` — serves static files from `/usr/share/nginx/html`. Comment explicitly states: "Static-only: serves index.html + /assets/*; no SPA fallback. Unknown paths 404."
- `marketing/Dockerfile` — single-stage build (`nginxinc/nginx-unprivileged`), just copies `index.html`, `robots.txt`, `sitemap.xml`, and `assets/` into the image. No Node/bundler/build step exists today.
- `marketing/deploy.sh` — builds the arm64 Docker image, pushes to ECR (`967807252336.dkr.ecr.us-east-1...`), and force-deploys ECS service `capiro-dev-marketing` on cluster `capiro-dev`. **Flag for the implementer/user**: despite the `dev` naming, the script's own comment says this is what serves the live `capiro.ai` domain. Confirm there is no separate staging service before assuming it's safe to test against — if `capiro-dev` is actually production, don't run `deploy.sh` until the change is verified locally.

## Target architecture

Traditional static multi-page site. No client-side routing, no JS required to navigate between sections.

| New file | Served at | Replaces |
|---|---|---|
| `index.html` | `/` | `page-home` |
| `platform.html` | `/platform` | `page-platform` |
| `solutions.html` | `/solutions` | `page-solutions` |
| `insights.html` | `/insights` | `page-insights` |
| `pricing.html` | `/pricing` | `page-pricing` |
| `privacy.html` | `/privacy` | `page-privacy` |
| `terms.html` | `/terms` | `page-terms` |

Use clean, extensionless URLs (`/platform`, not `/platform.html`) — handled in nginx, see step 6 below.

## Constraints / non-goals

- No visual, layout, or copy changes — same CSS, same design, same content per section.
- No new frontend framework. A tiny build step is fine (see approach below); a full SPA framework is not warranted for a 7-page static site.
- Preserve the "Request a demo" modal and its HubSpot form submission on every page.
- Preserve the Insights page's client-side fetch from `https://app.capiro.ai/api/insights`.
- Preserve existing nginx security headers, gzip config, and asset caching rules.
- Stays a static site — no backend/database introduced.

## Recommended approach: extract shared partials + a build-time templating step

Most of the file (styles, nav markup, footer markup, modal markup, and shared behavior JS) is identical across all 7 sections. Hand-duplicating that into 7 separate files invites drift — a nav or footer change made in one file and missed in the other six. Instead:

1. **Extract CSS**: move the inline `<style>` block to `marketing/assets/styles.css`. Reference it via `<link rel="stylesheet" href="/assets/styles.css">` on every page.
2. **Extract shared behavior JS**: move the inline `<script>` (mobile nav toggle, modal open/close, demo form submit, insights fetch) to `marketing/assets/main.js`. Reference via `<script src="/assets/main.js">` on every page. **Delete** `showPage`, `PAGE_META`, and `updateMeta` entirely — they're superseded by real per-page HTML and no longer needed.
3. **Create two templates**:
   - A header partial: opening `<html>`/`<head>` boilerplate + `<nav>`, with placeholders for `{{title}}`, `{{description}}`, `{{canonical}}`, `{{ogTitle}}`, `{{ogDescription}}`, etc.
   - A footer partial: footer markup + the demo modal + closing `</body></html>`.
4. **Extract the 7 page bodies**: today's `page-home`, `page-platform`, ... `<div>` contents (minus the `class="page"`/`id="page-X"` wrapper attributes, which no longer serve a purpose once each is its own document).
5. **Add a small build script** (`marketing/build.js` or `marketing/build.py` — plain string templating, no new dependency needed) that renders each of the 7 output HTML files as `header(page metadata) + page body + footer`. Metadata values (title/description per page) are already drafted in `marketing/seo/meta-tags-reference.md` from the prior SEO pass — reuse verbatim.
6. **Update `marketing/Dockerfile`**: add a build stage (`node:alpine` or `python:alpine`, whichever matches the build script's language) that runs the build script and produces the 7 static HTML files, then `COPY --from=build` those generated files into the nginx runtime stage in place of the current single `index.html` copy. The runtime image stays pure static files — no change to how nginx serves or how `deploy.sh` operates.
7. **Update `marketing/nginx/nginx.conf`** for clean URLs: change the catch-all `location /` block's `try_files` to also check the `.html` file, e.g. `try_files $uri $uri.html $uri/ =404;`, so `/platform` resolves to `platform.html` without the extension showing. Keep `/assets/`, `/healthz`, and the security headers exactly as they are.
8. **Fix navigation markup**: replace `onclick="showPage('platform')"` with real `<a href="/platform">` (keep `closeNav()` wired to the click for the mobile menu, but as a real link now, not a JS-only one). This also fixes the underlying crawlability problem — search engines can now actually follow internal links.
9. **Per-page `<head>` metadata**: give each generated page exactly one `<h1>`, its own `<title>`, meta description, canonical URL (`https://capiro.ai/platform`, etc.), and OG/Twitter tags — pull the copy from `marketing/seo/meta-tags-reference.md`.
10. **Update `marketing/sitemap.xml`**: list all 7 URLs with `lastmod`, replacing the current single-URL placeholder (which has a comment already noting this exact follow-up).

## Step-by-step task list

1. Read the full current `marketing/index.html` and confirm the exact boundaries of each `page-*` div and the shared nav/footer/modal markup.
2. Create `marketing/assets/styles.css` and `marketing/assets/main.js`; move the relevant blocks out of `index.html` into them.
3. Build the header/footer templates and the build script per the approach above.
4. Generate the 7 pages locally; visually diff each against the current live site to confirm no regression.
5. Update `nginx.conf` for extensionless routing.
6. Update `Dockerfile` to add the build stage.
7. Update `sitemap.xml` with all 7 URLs.
8. Update internal nav links (and any other in-page links that currently call `showPage()`) to use real `href`s.
9. Remove the now-dead `showPage`/`PAGE_META`/`updateMeta` JS.
10. Run through the verification checklist below before deploying.

## Verification checklist

- `docker build -f marketing/Dockerfile .` succeeds locally; run the container and `curl -I` each of the 7 URLs — expect `200` and a distinct `<title>` per page.
- Confirm an unknown path (e.g. `/nonsense`) still returns `404`.
- Confirm nav works with JavaScript disabled (real anchor navigation).
- Confirm the demo modal and HubSpot submission still work from every page, not just the homepage.
- Confirm the Insights page still fetches and renders from `https://app.capiro.ai/api/insights`.
- View-source each page: exactly one `<h1>`, unique title/description, correct canonical, valid JSON-LD (test with Google's Rich Results Test).
- Confirm `/robots.txt` and `/sitemap.xml` still return `200` and the sitemap lists all 7 URLs.
- Run Lighthouse/PageSpeed on `/` to confirm no regression from the current baseline (hero video autoplay behavior unchanged).

## Rollout plan

1. Do all of this on a branch, verified via local Docker build — do not touch the live `index.html` in place until the new structure passes the checklist above.
2. Before running `deploy.sh`, confirm with the user whether `capiro-dev` / `capiro-dev-marketing` is genuinely production or if a separate staging path exists. Test there first if one exists.
3. Once verified, run `marketing/deploy.sh` to build, push to ECR, and force the ECS deployment.
4. Post-deploy: resubmit `sitemap.xml` in Google Search Console and Bing Webmaster Tools; request indexing for each new URL individually.
5. Monitor access logs for unexpected 404s for the first few days (in case anything external links to the old single-URL site with an anchor/fragment).

## Rollback plan

Keep the previous single-file `index.html`/`Dockerfile` on the last known-good git tag. If the new deployment misbehaves, redeploy the previous ECS task definition/image tag via `aws ecs update-service`, or revert the branch and re-run `deploy.sh`.

## Explicitly out of scope (separate follow-ups, already tracked elsewhere)

- Migrating "The Cycle" newsletter content off Substack onto `/insights` (its own project — see the main SEO plan).
- Building the `/vs/quorum` comparison page (content brief already written in `marketing/seo/content-brief-capiro-vs-quorum.md`).
- Any visual/design changes.
