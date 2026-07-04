/*
 * Capiro marketing site build.
 *
 * Renders the multi-page static site from shared templates:
 *   templates/header.html  +  templates/pages/<page>.html  +  templates/footer.html
 * Each output page gets its own <title>, meta description, canonical, OG/Twitter
 * tags, and JSON-LD. Also (re)generates sitemap.xml from the same page list.
 *
 * Usage:
 *   node build.mjs                 # writes generated files into this directory (marketing/)
 *   OUT_DIR=/out node build.mjs    # writes them into /out (used by the Docker build stage)
 *
 * No dependencies — Node built-ins only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || HERE;
const SITE = 'https://capiro.ai';
const LASTMOD = '2026-07-03';
const OG_IMAGE = SITE + '/assets/hero-poster.jpg';

const read = (...p) => readFileSync(join(HERE, ...p), 'utf8');
const header = read('templates', 'header.html');
const footer = read('templates', 'footer.html');

// Pages, in sitemap order. slug '' => served at "/". `body` is the file under templates/pages/.
const PAGES = [
  {
    slug: '', out: 'index.html', body: 'home.html',
    title: 'Capiro — The Operating System for Government Affairs',
    description: 'Capiro is the AI-native operating platform for government affairs. Meri, your AI chief of staff, automates 80% of the back-office work — drafting, filing, tracking, and follow-up — so your practice spends its time on strategy and relationships.',
  },
  {
    slug: 'platform', out: 'platform.html', body: 'platform.html',
    title: 'Platform — Meet Meri, Your AI Chief of Staff | Capiro',
    description: 'Meri automates 80% of your back-office work. It answers questions grounded in Capiro data, drafts finished Office documents, takes action across your email and calendar, and remembers every client, meeting, and deadline.',
  },
  {
    slug: 'solutions', out: 'solutions.html', body: 'solutions.html',
    title: 'Solutions — Every Sector, One Platform | Capiro',
    description: 'From first draft to filed submission, Capiro produces every deliverable government affairs teams create. Defense and aerospace live now — NDAA authorizations, appropriations justifications, and CDS earmarks in minutes.',
  },
  {
    slug: 'insights', out: 'insights.html', body: 'insights.html',
    title: 'Insights — The Cycle | Capiro',
    description: 'The Cycle: government affairs intelligence for the people closest to the work. Read the latest analysis from Capiro on Substack.',
  },
  {
    slug: 'pricing', out: 'pricing.html', body: 'pricing.html',
    title: 'Pricing — Scales With Your Practice | Capiro',
    description: 'Client-based pricing that scales with your practice, not against it. One annual contract billed monthly, priced by your active client roster. No seat limits, no feature gates.',
  },
  {
    slug: 'privacy', out: 'privacy.html', body: 'privacy.html',
    title: 'Privacy Policy | Capiro',
    description: 'How Capiro, Inc. collects, uses, and protects your information across capiro.ai and the Capiro government affairs platform.',
  },
  {
    slug: 'terms', out: 'terms.html', body: 'terms.html',
    title: 'Terms of Service | Capiro',
    description: 'The terms governing use of the Capiro government affairs operating platform and website.',
  },
];

// Escape a value for use in an HTML attribute / <title>. Inputs use literal
// Unicode (e.g. em dash) rather than entities, so this only guards &, <, >, ".
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const canonicalFor = (slug) => SITE + '/' + slug;

function jsonLd(page, canonical) {
  const graph = [{
    '@type': 'WebPage',
    '@id': canonical + '#webpage',
    url: canonical,
    name: page.title,
    description: page.description,
    isPartOf: { '@id': SITE + '/#website' },
    publisher: { '@id': SITE + '/#organization' },
  }];
  if (page.slug === '') {
    graph.push({
      '@type': 'Organization',
      '@id': SITE + '/#organization',
      name: 'Capiro',
      legalName: 'Capiro, Inc.',
      url: SITE,
      logo: SITE + '/assets/logo.png',
      sameAs: ['https://www.linkedin.com/company/capirohq', 'https://capirohq.substack.com'],
      address: {
        '@type': 'PostalAddress',
        streetAddress: '2791 Centerboro Drive, Suite 186',
        addressLocality: 'Vienna',
        addressRegion: 'VA',
        postalCode: '22181',
        addressCountry: 'US',
      },
      contactPoint: { '@type': 'ContactPoint', email: 'info@capiro.ai', contactType: 'sales' },
    });
    graph.push({
      '@type': 'WebSite',
      '@id': SITE + '/#website',
      url: SITE,
      name: 'Capiro',
      publisher: { '@id': SITE + '/#organization' },
    });
  }
  const doc = { '@context': 'https://schema.org', '@graph': graph };
  return '<script type="application/ld+json">\n' + JSON.stringify(doc, null, 2) + '\n</script>\n';
}

const BANNER = '<!-- Generated by marketing/build.mjs from templates/ — do not edit directly. -->';

mkdirSync(OUT, { recursive: true });

for (const page of PAGES) {
  const canonical = canonicalFor(page.slug);
  const head = header
    .replaceAll('{{TITLE}}', attr(page.title))
    .replaceAll('{{OG_TITLE}}', attr(page.title))
    .replaceAll('{{DESCRIPTION}}', attr(page.description))
    .replaceAll('{{CANONICAL}}', attr(canonical))
    .replace('{{HEAD_EXTRA}}', jsonLd(page, canonical))
    .replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + BANNER + '\n');
  const body = read('templates', 'pages', page.body);
  writeFileSync(join(OUT, page.out), head + body + '\n' + footer);
}

const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  PAGES.map((p) =>
    '  <url>\n    <loc>' + canonicalFor(p.slug) + '</loc>\n    <lastmod>' + LASTMOD + '</lastmod>\n  </url>'
  ).join('\n') +
  '\n</urlset>\n';
writeFileSync(join(OUT, 'sitemap.xml'), sitemap);

console.log('Built ' + PAGES.length + ' pages + sitemap.xml -> ' + OUT);
for (const p of PAGES) console.log('  /' + p.slug + '  ->  ' + p.out);
