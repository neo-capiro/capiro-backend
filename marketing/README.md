# Capiro marketing site (capiro.ai)

A static, multi-page site. Every section is its own crawlable URL with its own
`<title>`, meta description, canonical tag, and single `<h1>`.

## Source of truth — edit these, not the generated files

```
templates/header.html      opening <html>/<head> + <nav>  (has {{TITLE}}, {{DESCRIPTION}}, {{CANONICAL}}, {{OG_TITLE}}, {{HEAD_EXTRA}} placeholders)
templates/footer.html      <footer> + demo modal + <script src="/assets/main.js"> + closing tags
templates/pages/*.html     one file per page (body only, no shared chrome)
assets/styles.css          all CSS (incl. the base64 CreatoDisplay / CapiroRegular @font-face)
assets/main.js             shared behavior: mobile nav, demo modal, HubSpot submit, Insights fetch
build.mjs                  page list + per-page SEO metadata; renders the site
```

Page-specific code (the Solutions industry tabs + the d3 "pathway map") lives
inline in `templates/pages/solutions.html`, not in the shared `main.js`.

## Build

```
pnpm marketing:build       # from the repository root
pnpm marketing:test        # build + support-route contract checks
```

The generated `*.html` files **are committed** (so you can diff rendered output
and eyeball SEO tags), but they carry a `do not edit directly` banner — change a
template and re-run `node build.mjs`. The Docker image regenerates them from
`templates/` in a Node build stage, so the deployed artifact is always fresh
regardless of the committed copies. `robots.txt` is static.

## Add a page

1. Add `templates/pages/<name>.html` (body only).
2. Add an entry to the `PAGES` array in `build.mjs` (slug, out file, title, description).
3. `node build.mjs`. The sitemap updates automatically.

## URLs / routing

nginx serves clean URLs via `try_files $uri $uri.html $uri/ =404` — `/platform`
resolves to `platform.html`, unknown paths 404. See `nginx/nginx.conf`.

## Deploy

`./deploy.sh` builds the arm64 image, pushes to ECR, and force-deploys ECS
service `capiro-dev-marketing`. **This serves the live capiro.ai domain** — build
and verify locally first.

### Support page / App Store release gate

The `/support` source is checked by `support.contract.test.mjs`, but a checked-in
`support.html` does not prove that the public URL is deployed. After this change
is merged, the release owner must use the approved marketing deployment flow
and verify the live artifact before using it in App Store metadata:

```sh
curl --fail --silent --show-error https://capiro.ai/support
curl --fail --silent --show-error https://capiro.ai/sitemap.xml
```

Confirm the support response is HTTPS/200, has the canonical
`https://capiro.ai/support`, links to `https://capiro.ai/privacy`, and exposes
`info@capiro.ai` without redirecting to another organization. Only then replace
`REQUIRED_PUBLISHED_HTTPS_SUPPORT_URL` in the Meri release inputs. This repository
change does not deploy the page.
