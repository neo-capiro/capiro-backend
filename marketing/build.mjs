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

// Paid-acquisition tracking. Both IDs empty => NO tags emitted (zero prod impact).
// Set both to activate site-wide: GTM loads on every page and the demo-request
// conversion is pushed to dataLayer as `demo_request` from submitDemo() (wire the
// LinkedIn Insight + Google Ads conversion tags off that event inside the GTM UI).
const TRACKING = {
  gtmId: process.env.GTM_ID || '',                          // e.g. 'GTM-XXXXXXX' (none yet — no GTM container)
  linkedInPartnerId: process.env.LI_PARTNER_ID || '9369930', // LinkedIn Insight Tag partner id (Capiro Campaign Manager)
  linkedInConversionId: process.env.LI_CONVERSION_ID || '28743210', // LinkedIn "Demo Request" event-specific conversion id (fired by main.js on demo success)
};

function trackingHead() {
  let out = '';
  if (TRACKING.gtmId) {
    out +=
      "<!-- Google Tag Manager -->\n<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','" +
      TRACKING.gtmId + "');</script>\n<!-- End Google Tag Manager -->\n";
  }
  if (TRACKING.linkedInPartnerId) {
    out +=
      '<!-- LinkedIn Insight Tag -->\n<script type="text/javascript">_linkedin_partner_id="' +
      TRACKING.linkedInPartnerId +
      '";window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);</script>\n<script type="text/javascript">(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);})(window.lintrk);</script>\n<!-- End LinkedIn Insight Tag -->\n';
  }
  if (TRACKING.linkedInConversionId) {
    // Exposed for main.js showDemoSuccess() -> lintrk('track', {conversion_id}).
    out += '<script>window._capiroLiConversionId=' + TRACKING.linkedInConversionId + ';</script>\n';
  }
  return out;
}

function trackingBody() {
  let out = '';
  if (TRACKING.gtmId) {
    out +=
      '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=' +
      TRACKING.gtmId +
      '" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n';
  }
  if (TRACKING.linkedInPartnerId) {
    out +=
      '<noscript><img height="1" width="1" style="display:none;" alt="" src="https://px.ads.linkedin.com/collect/?pid=' +
      TRACKING.linkedInPartnerId + '&fmt=gif" /></noscript>\n';
  }
  return out;
}

// Normalize CRLF->LF so the build is deterministic regardless of the checkout's
// line endings (Windows git autocrlf would otherwise break the newline-sensitive
// string replaces below and diverge from the Linux CI build).
const read = (...p) => readFileSync(join(HERE, ...p), 'utf8').replace(/\r\n/g, '\n');
const header = read('templates', 'header.html');
const footer = read('templates', 'footer.html');

// The home page ships its own chrome: a light theme, a transparent-over-hero nav
// and its own stylesheet (assets/home.css). The other six pages keep the shared
// dark-theme header/footer and assets/styles.css untouched. Selected per page
// via `chrome: 'home'` below.
const CHROME = {
  default: { header, footer },
  home: { header: read('templates', 'header-home.html'), footer: read('templates', 'footer-home.html') },
};
const ICONS = read('templates', 'icons-sprite.html');

// Pages, in sitemap order. slug '' => served at "/". `body` is the file under templates/pages/.
const PAGES = [
  {
    slug: '', out: 'index.html', body: 'home.html', chrome: 'home',
    title: 'Capiro — AI Chief of Staff & Operating System for Government Affairs',
    description: 'Capiro is the operating system for government affairs teams. Meri, your AI Chief of Staff, tracks legislation, drafts outreach, and manages every client and capability in one platform. Measured by outcomes.',
  },
  {
    slug: 'platform', out: 'platform.html', body: 'platform.html',
    title: 'Platform — Meri, Your AI Chief of Staff | Capiro',
    description: 'Meet Meri: the AI Chief of Staff that tracks legislation, drafts outreach, and remembers every client objective so your government affairs team can act, not just monitor.',
  },
  {
    slug: 'solutions', out: 'solutions.html', body: 'solutions.html',
    title: 'Solutions for Every Government Affairs Practice | Capiro',
    description: 'From lobbying firms to corporate government affairs teams and associations — see how Capiro adapts to every sector and practice type.',
  },
  {
    slug: 'insights', out: 'insights.html', body: 'insights.html',
    title: 'Insights — The Cycle by Capiro',
    description: 'The Cycle: analysis and updates on government affairs, legislative trends, and how AI is changing advocacy work.',
  },
  {
    slug: 'pricing', out: 'pricing.html', body: 'pricing.html',
    title: 'Pricing | Capiro',
    description: 'Capiro scales with your practice, not against it. See plans built for government affairs teams of every size.',
  },
  {
    slug: 'privacy', out: 'privacy.html', body: 'privacy.html',
    title: 'Privacy Policy | Capiro',
    description: 'How Capiro collects, uses, and protects your information.',
  },
  {
    slug: 'terms', out: 'terms.html', body: 'terms.html',
    title: 'Terms of Service | Capiro',
    description: 'The terms governing use of Capiro\'s platform and services.',
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
    graph.push({
      '@type': 'SoftwareApplication',
      name: 'Capiro',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      description: 'Capiro is an AI-powered operating system for government affairs teams — legislative tracking, stakeholder engagement, outreach drafting, and client management in one platform.',
      url: SITE + '/',
      offers: { '@type': 'Offer', url: SITE + '/pricing' },
    });
  }
  const doc = { '@context': 'https://schema.org', '@graph': graph };
  return '<script type="application/ld+json">\n' + JSON.stringify(doc, null, 2) + '\n</script>\n';
}

const BANNER = '<!-- Generated by marketing/build.mjs from templates/ — do not edit directly. -->';

mkdirSync(OUT, { recursive: true });

for (const page of PAGES) {
  const canonical = canonicalFor(page.slug);
  const chrome = CHROME[page.chrome || 'default'];
  if (!chrome) throw new Error('unknown chrome "' + page.chrome + '" for /' + page.slug);
  const head = chrome.header
    .replace('{{ICONS}}', ICONS)
    .replaceAll('{{TITLE}}', attr(page.title))
    .replaceAll('{{OG_TITLE}}', attr(page.title))
    .replaceAll('{{DESCRIPTION}}', attr(page.description))
    .replaceAll('{{CANONICAL}}', attr(canonical))
    .replace('{{HEAD_EXTRA}}', jsonLd(page, canonical))
    .replace('{{TRACKING_HEAD}}', trackingHead())
    .replace('{{TRACKING_BODY}}', trackingBody())
    .replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + BANNER + '\n');
  const body = read('templates', 'pages', page.body);
  writeFileSync(join(OUT, page.out), head + body + '\n' + chrome.footer);
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
