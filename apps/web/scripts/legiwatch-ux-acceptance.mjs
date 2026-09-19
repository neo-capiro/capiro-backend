import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const evidenceDir = process.env.LEGIWATCH_QA_EVIDENCE ?? 'C:/dev/main/outputs/legiwatch-ux-implementation-qa/fixture';
const baseURL = process.env.LEGIWATCH_QA_URL ?? 'http://127.0.0.1:5176/legiwatch?tab=hearings';
const server = process.env.LEGIWATCH_QA_URL ? null : spawn(process.execPath, [viteCli, '--config', 'vite.legiwatch-qa.config.ts', '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit', windowsHide: true });
const checks = [];
const diagnostics = { pageErrors: [], failedRequests: [], httpErrors: [] };
const record = (name, passed, detail = '') => checks.push({ name, passed, detail });
const fail = (name, error) => record(name, false, String(error).slice(0, 500));

async function waitForServer(page) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('[data-module="legiwatch"]').waitFor({ timeout: 60000 });
  await page.waitForTimeout(400);
}

async function waitForServerReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`LegiWatch QA server did not become ready: ${baseURL}`);
}

function observe(page) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)));
  page.on('requestfailed', (request) => diagnostics.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  page.on('response', (response) => { if (response.status() >= 400) diagnostics.httpErrors.push(`${response.status()} ${response.url()}`); });
}

async function clickDestination(page, name, locator, urlPart, contentLocator) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    await locator.click();
    await page.waitForTimeout(250);
    const urlOK = page.url().includes(urlPart);
    await contentLocator.waitFor({ state: 'visible', timeout: 5000 });
    record(`${name}: click, URL, and content`, urlOK, `url=${page.url()}`);
  } catch (error) {
    fail(`${name}: click, URL, and content`, error);
  }
}

async function checkViewport(page, viewport, results) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  record(`${viewport.name}: no horizontal overflow`, !overflow, `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  if (viewport.width <= 390) {
    const header = await page.evaluate(() => {
      const title = document.querySelector('.lw-h1')?.getBoundingClientRect();
      const controls = [...document.querySelectorAll('.lw-pagehead__actions button')]
        .filter((element) => getComputedStyle(element).display !== 'none')
        .map((element) => ({ name: element.getAttribute('aria-label') || element.textContent?.trim(), rect: element.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 0 && item.rect.height > 0);
      const outside = controls.filter(({ rect }) => rect.left < -1 || rect.right > innerWidth + 1);
      const overlapsTitle = title ? controls.filter(({ rect }) => rect.left < title.right && rect.right > title.left && rect.top < title.bottom && rect.bottom > title.top) : [];
      const overlapsControls = controls.flatMap((item, index) => controls.slice(index + 1).filter(({ rect }) => item.rect.left < rect.right && item.rect.right > rect.left && item.rect.top < rect.bottom && item.rect.bottom > rect.top).map((other) => `${item.name}/${other.name}`));
      return { outside: outside.map((item) => item.name), overlapsTitle: overlapsTitle.map((item) => item.name), overlapsControls };
    });
    record(`${viewport.name}: header actions fit`, header.outside.length === 0 && header.overlapsTitle.length === 0 && header.overlapsControls.length === 0, JSON.stringify(header));
  }
  await page.screenshot({ path: `${evidenceDir}/legiwatch-${viewport.name}.png`, fullPage: true });
  const hearingY = await page.locator('text=Oversight hearing fixture').first().boundingBox({ timeout: 3000 }).then((b) => b?.y ?? null).catch(() => null);
  const billsURL = new URL(baseURL);
  billsURL.searchParams.set('tab', 'bills');
  billsURL.searchParams.set('corpusQ', 'H.R. 8800');
  await page.goto(billsURL.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('H.R. 8800', { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => undefined);
  const billY = await page.locator('text=H.R. 8800').first().boundingBox({ timeout: 3000 }).then((b) => b?.y ?? null).catch(() => null);
  await page.screenshot({ path: `${evidenceDir}/legiwatch-bills-${viewport.name}.png`, fullPage: true });
  results.push({ viewport: viewport.name, billY, hearingY });
  if (viewport.firstItemLimit) {
    record(`${viewport.name}: first hearing near top`, hearingY !== null && hearingY <= viewport.firstItemLimit, `y=${hearingY}; limit=${viewport.firstItemLimit}`);
    record(`${viewport.name}: first bill near top`, billY !== null && billY <= viewport.firstItemLimit, `y=${billY}; limit=${viewport.firstItemLimit}`);
  }
}

const browser = await chromium.launch({ headless: true });
try {
  await mkdir(evidenceDir, { recursive: true });
  await waitForServerReady();
  const results = [];
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900, firstItemLimit: 600 },
    { name: 'compact-desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'zoom-200-viewport', width: 720, height: 450 },
    { name: 'mobile', width: 390, height: 844, firstItemLimit: 700 },
    { name: 'narrow-mobile', width: 320, height: 700 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    observe(page);
    await waitForServer(page);
    if (viewport.name === 'zoom-200-viewport') {
      record('200% equivalent viewport uses compact navigation',
        await page.locator('.lw-mobile-nav').isVisible()
          && !await page.locator('.lw-tabs').isVisible());
    }
    if (viewport.width <= 390) {
      try {
        await page.locator('.lw-mobile-nav').getByRole('combobox', { name: 'LegiWatch section', exact: true }).selectOption('digest');
        record(`${viewport.name}: primary selector`, page.url().includes('tab=digest'), page.url());
        await page.locator('.lw-mobile-nav').getByRole('combobox', { name: 'More LegiWatch sections', exact: true }).selectOption('committees');
        record(`${viewport.name}: secondary selector`, page.url().includes('tab=committees'), page.url());
      } catch (error) { fail(`${viewport.name}: mobile selectors`, error); }
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    }
    await checkViewport(page, viewport, results);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  observe(page);
  await waitForServer(page);
  const primary = [
    ['Updates', 'tab=feed', page.getByRole('tab', { name: /^Updates/ }) , page.getByRole('heading', { name: 'Updates' })],
    ['Watchlists', 'tab=bills', page.getByRole('tab', { name: /^Watchlists$/ }), page.getByRole('heading', { name: /Watchlists|Bills/ })],
    ['Research', 'tab=research', page.getByRole('tab', { name: /^Research$/ }), page.getByRole('heading', { name: /Research/ })],
    ['Hearings', 'tab=hearings', page.getByRole('tab', { name: /^Hearings$/ }), page.getByRole('heading', { name: /Hearings/ })],
    ['Reports', 'tab=digest', page.getByRole('tab', { name: /^Reports$/ }), page.getByRole('heading', { name: 'Reports', exact: true })],
  ];
  for (const [name, urlPart, locator, content] of primary) await clickDestination(page, name, locator, urlPart, content);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await clickDestination(page, 'Committees', page.locator('.lw-tabs__secondary').getByRole('button', { name: 'Committees' }), 'tab=committees', page.getByRole('heading', { name: 'Committees', exact: true }));
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const settings = page.getByRole('button', { name: /LegiWatch settings/i });
  await clickDestination(page, 'Settings', settings, 'tab=settings', page.getByRole('heading', { name: /Settings/i }));

  const before = page.url();
  await page.getByRole('tab', { name: /^Watchlists$/ }).click();
  await page.waitForURL(/tab=bills/);
  await page.evaluate(() => history.back());
  await page.waitForURL(before);
  record('browser Back restores prior destination', page.url() === before, `expected=${before} actual=${page.url()}`);
  await page.evaluate(() => history.forward());
  await page.waitForURL(/tab=bills/);
  record('browser Forward restores bills destination', page.url().includes('tab=bills'), `actual=${page.url()}`);

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Search LegiWatch' }).click();
  const search = page.getByRole('dialog', { name: 'Search LegiWatch' });
  await search.waitFor({ state: 'visible' });
  const info = search.getByRole('button', { name: 'Bill information' });
  const docs = search.getByRole('button', { name: 'Bill-document text' });
  await info.click();
  await search.getByLabel('Search LegiWatch').fill('8800');
  await search.getByRole('link', { name: /H\.R\. 8800/ }).first().waitFor({ state: 'visible', timeout: 5000 });
  record('search information mode returns a bill', await info.getAttribute('aria-pressed') === 'true');
  await docs.click();
  const jurisdiction = search.getByLabel('Bill text jurisdiction');
  if (await jurisdiction.isVisible().catch(() => false)) {
    await jurisdiction.fill('US');
    await search.getByLabel('Bill text session').fill('119');
    await search.getByText('Deterministic bill-document text fixture.').waitFor({ state: 'visible', timeout: 5000 });
    record('search document mode has scoped fields', await docs.getAttribute('aria-pressed') === 'true'
      && await search.getByText('Effective scope: US · 119').isVisible());
  } else {
    record('search explains unavailable bill research', await search.getByText(/Bill research is not enabled for this workspace/).isVisible());
  }
  await page.screenshot({ path: `${evidenceDir}/legiwatch-search-modes.png`, fullPage: true });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const calendarDate = page.getByLabel('Calendar date', { exact: true });
  await calendarDate.fill('2026-09-19');
  record('desktop calendar date updates URL', new URL(page.url()).searchParams.get('calendarDate') === '2026-09-19');
  await page.getByRole('tablist', { name: 'Calendar range' }).getByRole('tab', { name: 'Day' }).click();
  record('desktop day/week range updates URL', new URL(page.url()).searchParams.get('calendarRange') === 'day');

  await page.goto(new URL('/legiwatch?tab=digest', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Your reports' }).waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Open intelligence brief' }).click();
  record('legacy intelligence brief remains reachable', new URL(page.url()).searchParams.get('digestMode') === 'legacy');
  await page.goto(new URL('/legiwatch?tab=digest', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create report' }).click();
  const newReport = page.getByRole('dialog', { name: 'New report' });
  record('report creation opens its editor', await newReport.isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.waitForTimeout(200);
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  record('200% zoom has no horizontal overflow', !zoomOverflow, `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  const zoomNav = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.lw-tabs button')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => ({ name: element.textContent?.trim(), rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
    const overlaps = buttons.flatMap((item, index) => buttons.slice(index + 1)
      .filter((other) => item.rect.left < other.rect.right - 1 && item.rect.right > other.rect.left + 1
        && item.rect.top < other.rect.bottom - 1 && item.rect.bottom > other.rect.top + 1)
      .map((other) => `${item.name}/${other.name}`));
    return { overlaps };
  });
  record('200% zoom navigation does not overlap', zoomNav.overlaps.length === 0, JSON.stringify(zoomNav));
  await page.screenshot({ path: `${evidenceDir}/legiwatch-200-percent.png`, fullPage: true });
  await page.close();

  const mobileJourney = await browser.newPage({ viewport: { width: 390, height: 844 } });
  observe(mobileJourney);
  await waitForServer(mobileJourney);
  await mobileJourney.getByRole('button', { name: 'Calendar filters' }).click();
  const mobileFilters = mobileJourney.getByRole('dialog', { name: 'Calendar filters' });
  record('mobile calendar filters open', await mobileFilters.isVisible());
  record('mobile hearing controls retained', await mobileFilters.getByRole('tab', { name: 'Day' }).isVisible().catch(() => false)
    && await mobileFilters.getByRole('tab', { name: 'Week' }).isVisible().catch(() => false)
    && await mobileFilters.getByRole('button', { name: 'Export calendar' }).isVisible().catch(() => false));
  await mobileFilters.getByRole('tab', { name: 'Day' }).click();
  record('mobile calendar range persists', new URL(mobileJourney.url()).searchParams.get('calendarRange') === 'day');
  await mobileJourney.close();

  record('no uncaught page errors', diagnostics.pageErrors.length === 0, diagnostics.pageErrors.join('; '));
  record('no failed essential requests', diagnostics.failedRequests.length === 0, diagnostics.failedRequests.join('; '));
  record('no HTTP errors', diagnostics.httpErrors.length === 0, diagnostics.httpErrors.join('; '));
  const output = { generatedAt: new Date().toISOString(), baseURL, checks, diagnostics, firstItemPositions: results, smokeScope: 'QA fixture visual/interaction smoke only; canned mutation API does not prove persistence.', unverified: ['real persistence, generation, delivery, recording, and production workflows are intentionally unmodeled'] };
  await writeFile(`${evidenceDir}/legiwatch-qa-results.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (checks.some((check) => !check.passed)) process.exitCode = 1;
} finally {
  await browser.close();
  if (server) { server.kill('SIGTERM'); await new Promise((resolve) => setTimeout(resolve, 500)); }
}
