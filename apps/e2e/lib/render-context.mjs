/**
 * Shared RENDER-CONTEXT helper (CleanUp1 §8.5, root review round 67 / 73).
 *
 * The determinism contract for "did these two runs render the SAME thing?" is
 * not only the browser executable/fonts/image: it also includes the browser
 * CONTEXT the pages were rendered in — the ACTUAL PROJECT VIEWPORTS, the colour
 * scheme, the media type, the locale, the timezone, the device scale factor,
 * the reduced-motion preference and the ACTUAL fixed clock APPLIED to the real
 * capture pages. Those context values decide layout/pixels, so a renderer
 * contract that omits them is INCOMPLETE.
 *
 * Round-73 correction: the previous version OBSERVED a set of FRESH SYNTHETIC
 * contexts it created itself from DECLARED_RENDER_CONTEXT and then recorded
 * those. That could never prove anything about the pixels the tests ACTUALLY
 * captured, and the recorded clock was a hard-coded string. This module now
 * consumes observations taken from the REAL route-capture / regression /
 * strict-repeat pages AND the SEPARATE onboarding page, produced by the specs
 * via {@link recordRenderObservation}, and aggregates them with
 * {@link aggregateRenderContext}, which REFUSES a missing project, a
 * disagreement between projects, a missing onboarding context, or a clock that
 * is not the ACTUAL applied fixed clock. No synthetic probe context is ever
 * created and no declared value is substituted for a real observation.
 *
 * This module is the SINGLE source of truth for the render context and is
 * imported by:
 *   - apps/e2e/lib/renderer-contract.mjs  (folds it into the ONE kernel),
 *   - apps/e2e/lib/runtime-identity.mjs    (reads the observed contexts),
 *   - the Playwright specs (record the ACTUAL page context),
 *   - apps/e2e/lib/render-context-controls.mjs (pure adverse controls).
 *
 * The declared contract values come from the ACTUAL resolved project values
 * (`PROJECTS` / `ONBOARD_PROJECT` — the same constants playwright.config.ts and
 * playwright.onboard.config.ts consume); observations are made from REAL pages,
 * never invented.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS, ONBOARD_PROJECT, LOCALE, TIMEZONE, FIXED_CLOCK_ISO } from './projects.mjs';

export const RENDER_OBSERVATION_SCHEMA = 'capiro.cleanup1.render-context-observations.v1';

/** The canonical declared render-context profile (the real project contract). */
export const DECLARED_RENDER_CONTEXT = Object.freeze({
  viewports: Object.freeze(
    PROJECTS.map((p) => Object.freeze({ name: p.name, width: p.viewport.width, height: p.viewport.height })),
  ),
  colorScheme: 'light',
  mediaType: 'screen',
  locale: LOCALE,
  timezone: TIMEZONE,
  deviceScaleFactor: 1,
  reducedMotion: 'reduce',
  fixedClock: FIXED_CLOCK_ISO,
});

/** The three actual route project viewports (ordered as declared). */
export const PROJECT_VIEWPORTS = DECLARED_RENDER_CONTEXT.viewports;

/** The resolved route project names and the separate onboarding project name. */
export const ROUTE_PROJECT_NAMES = Object.freeze(PROJECTS.map((p) => p.name));
export const ONBOARD_PROJECT_NAME = ONBOARD_PROJECT.name;

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A canonical fixed clock is an exact ISO-8601 millisecond instant, or null. */
export function canonicalFixedClock(value) {
  return typeof value === 'string' && ISO_MS.test(value) ? value : null;
}

/**
 * Canonicalise a viewport list into a stable, order-independent shape:
 * a non-empty array of {name,width,height} sorted by name, or `null` when the
 * value is absent/malformed. `null` must be treated as INCOMPLETE, never as an
 * empty-but-valid set.
 */
export function canonicalViewports(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = [];
  for (const e of value) {
    if (!e || typeof e.name !== 'string' || e.name.length === 0) return null;
    if (!Number.isInteger(e.width) || e.width <= 0) return null;
    if (!Number.isInteger(e.height) || e.height <= 0) return null;
    out.push({ name: e.name, width: e.width, height: e.height });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Problems for the ACTUAL recorded project viewports: they must exist, be
 * well-formed, and be exactly the resolved project viewports (by name AND
 * dimensions). An empty/malformed/missing list is a refusal, never a pass.
 */
export function projectViewportProblems(viewports) {
  const problems = [];
  const canon = canonicalViewports(viewports);
  if (!canon) {
    problems.push('viewports missing/malformed (the actual project viewports were not recorded)');
    return problems;
  }
  const want = canonicalViewports(DECLARED_RENDER_CONTEXT.viewports.map((v) => ({ ...v })));
  const got = new Map(canon.map((v) => [v.name, v]));
  const wantMap = new Map(want.map((v) => [v.name, v]));
  for (const [name, w] of wantMap) {
    const g = got.get(name);
    if (!g) {
      problems.push(`project viewport '${name}' was not recorded`);
      continue;
    }
    if (g.width !== w.width || g.height !== w.height) {
      problems.push(`project viewport '${name}' observed ${g.width}x${g.height} != resolved ${w.width}x${w.height}`);
    }
  }
  for (const name of got.keys()) {
    if (!wantMap.has(name)) problems.push(`unexpected viewport '${name}' recorded (not a resolved project)`);
  }
  return problems;
}

/** The plain profile fields (no bookkeeping) of one observation. */
function profileOf(o) {
  return {
    viewport: o && o.viewport,
    colorScheme: o && o.colorScheme,
    mediaType: o && o.mediaType,
    locale: o && o.locale,
    timezone: o && o.timezone,
    deviceScaleFactor: o && o.deviceScaleFactor,
    reducedMotion: o && o.reducedMotion,
    fixedClock: o && o.fixedClock,
  };
}

/**
 * Problems for ONE observed page-context profile. Every field must be present
 * and well-formed — a field that could not be observed is a refusal, never a
 * guessed default.
 */
export function profileProblems(profile, { label = 'page context' } = {}) {
  const problems = [];
  const push = (m) => problems.push(`${label}: ${m}`);
  if (!profile || typeof profile !== 'object') {
    push('missing/malformed (the actual page context was not observed)');
    return problems;
  }
  const vp = profile.viewport;
  if (!vp || !Number.isInteger(vp.width) || vp.width <= 0 || !Number.isInteger(vp.height) || vp.height <= 0) {
    push('viewport missing/malformed');
  }
  if (profile.colorScheme !== 'light' && profile.colorScheme !== 'dark') push('colorScheme must be light|dark');
  if (profile.mediaType !== 'screen' && profile.mediaType !== 'print') push('mediaType must be screen|print');
  if (typeof profile.locale !== 'string' || !profile.locale) push('locale missing');
  if (typeof profile.timezone !== 'string' || !profile.timezone) push('timezone missing');
  if (!Number.isFinite(profile.deviceScaleFactor) || profile.deviceScaleFactor <= 0) push('deviceScaleFactor missing');
  if (typeof profile.reducedMotion !== 'boolean') push('reducedMotion missing');
  if (!canonicalFixedClock(profile.fixedClock)) push('fixedClock missing/malformed (the ACTUAL applied clock was not observed)');
  return problems;
}

/**
 * Observe the ACTUAL page context of a REAL page being used for a capture. Every
 * value is read back from the live page; the clock is the ACTUAL value the page
 * reports (after the fixture applied `page.clock.setFixedTime`) — never a source
 * constant. A value that cannot be read stays `null` so the contract refuses.
 *
 * @param {import('@playwright/test').Page} page a live page in the capture context
 * @returns {Promise<{viewport:{width:number,height:number}, colorScheme:(string|null),
 *   mediaType:(string|null), locale:(string|null), timezone:(string|null),
 *   deviceScaleFactor:(number|null), reducedMotion:(boolean|null), fixedClock:(string|null)}>}
 */
export async function observePageRenderContext(page) {
  const obs = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    print: window.matchMedia('(print)').matches,
    dpr: window.devicePixelRatio,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nowMs: Date.now(),
  }));
  return {
    viewport: { width: obs.width, height: obs.height },
    colorScheme: obs.dark ? 'dark' : 'light',
    mediaType: obs.print ? 'print' : 'screen',
    locale: typeof obs.language === 'string' && obs.language ? obs.language : null,
    timezone: typeof obs.timezone === 'string' && obs.timezone ? obs.timezone : null,
    deviceScaleFactor: Number.isFinite(obs.dpr) ? obs.dpr : null,
    reducedMotion: obs.reduce,
    fixedClock: Number.isFinite(obs.nowMs) ? new Date(obs.nowMs).toISOString() : null,
  };
}

/** Read an observation document, structurally. Returns {ok, doc|error}. */
export function readRenderObservations(file) {
  if (typeof file !== 'string' || !file) return { ok: false, error: 'no observation file path supplied' };
  if (!fs.existsSync(file)) return { ok: false, error: `observation file not found: ${file}` };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `observation file is not valid JSON: ${e.message}` };
  }
  if (!doc || typeof doc !== 'object' || doc.schema !== RENDER_OBSERVATION_SCHEMA || !Array.isArray(doc.observations)) {
    return { ok: false, error: 'observation file has an unexpected schema' };
  }
  return { ok: true, doc };
}

/**
 * Append ONE actual page-context observation for `project` during `phase`.
 * Sequential by contract (workers=1, fullyParallel:false), so a simple
 * read-modify-write is safe. Returns true when written.
 */
export function appendRenderObservation(file, record) {
  if (typeof file !== 'string' || !file) return false;
  if (!record || typeof record !== 'object' || typeof record.project !== 'string' || !record.project) return false;
  let doc = { schema: RENDER_OBSERVATION_SCHEMA, observations: [] };
  if (fs.existsSync(file)) {
    // REFUSE a malformed existing document instead of silently replacing it
    // (root review round 80): replacing it would discard observations already
    // recorded for the other pages and let an incomplete set masquerade as a
    // complete one at aggregation time.
    let cur;
    try {
      cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`existing render-context observations are not valid JSON (refusing to reset them): ${e.message}`);
    }
    if (!cur || cur.schema !== RENDER_OBSERVATION_SCHEMA || !Array.isArray(cur.observations)) {
      throw new Error('existing render-context observations have an unexpected schema (refusing to reset them)');
    }
    doc = cur;
  }
  doc.observations.push({
    project: record.project,
    phase: typeof record.phase === 'string' ? record.phase : '',
    observedAt: new Date().toISOString(),
    viewport: record.viewport,
    colorScheme: record.colorScheme,
    mediaType: record.mediaType,
    locale: record.locale,
    timezone: record.timezone,
    deviceScaleFactor: record.deviceScaleFactor,
    reducedMotion: record.reducedMotion,
    fixedClock: record.fixedClock,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`, 'utf8');
  return true;
}

/**
 * Observe + record the ACTUAL page context of `page` for `project` during
 * `phase`. A no-op (returns false) when `file` is empty — a plain local run
 * records nothing and therefore cannot publish; the producer always supplies the
 * file. When `file` IS supplied, a recording failure is NOT swallowed: the helper
 * THROWS (fail closed) so the caller fails the real test rather than letting a
 * page's observation silently go missing. (root review round 80)
 */
export async function recordRenderObservation({ file, phase, project, page }) {
  if (typeof file !== 'string' || !file) return false;
  if (typeof project !== 'string' || !project) throw new Error('render-context observation requires a project name');
  const profile = await observePageRenderContext(page);
  const written = appendRenderObservation(file, { project, phase, ...profile });
  if (!written) throw new Error('render-context observation could not be recorded');
  return true;
}

/**
 * Aggregate the ACTUAL page observations into the ONE complete render-context
 * contract. FAIL-CLOSED on every review-required hole:
 *   - every resolved route project must be observed;
 *   - the SEPARATE onboarding project must be observed;
 *   - the context fields (except viewport) must AGREE across projects/captures;
 *   - the observed clock must equal the ACTUAL applied fixed clock.
 * Returns { problems, context } — `context` is null whenever `problems` is
 * non-empty. Never substitutes a declared value for a missing observation.
 */
export function aggregateRenderContext(doc, { routeProjects = ROUTE_PROJECT_NAMES, onboardProject = ONBOARD_PROJECT_NAME } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.observations)) {
    return { problems: ['render-context observations missing/malformed (the producer must supply ACTUAL page observations)'], context: null };
  }
  const byProject = new Map();
  for (const o of doc.observations) {
    if (!o || typeof o !== 'object' || typeof o.project !== 'string' || !o.project) {
      problems.push('an observation record has no project name');
      continue;
    }
    const arr = byProject.get(o.project) || [];
    arr.push(o);
    byProject.set(o.project, arr);
  }
  const key = (p) => JSON.stringify(p);

  // ---- route projects (the 411 base + repeat captures) ---------------------
  const routeProfiles = [];
  for (const name of routeProjects) {
    const list = byProject.get(name);
    if (!list || list.length === 0) {
      problems.push(`route project '${name}' page context was NOT observed`);
      continue;
    }
    for (const o of list) for (const p of profileProblems(profileOf(o), { label: `route project '${name}'` })) problems.push(p);
    const first = profileOf(list[0]);
    for (const o of list.slice(1)) {
      if (key(profileOf(o)) !== key(first)) problems.push(`route project '${name}' page contexts DISAGREE between captures`);
    }
    routeProfiles.push({ name, ...first });
  }

  // ---- cross-project coherence (all fields except viewport must match) ------
  if (routeProfiles.length === routeProjects.length) {
    const base = routeProfiles[0];
    for (const rp of routeProfiles) {
      for (const field of ['colorScheme', 'mediaType', 'locale', 'timezone', 'deviceScaleFactor', 'reducedMotion', 'fixedClock']) {
        if (rp[field] !== base[field]) problems.push(`route projects DISAGREE on ${field} ('${rp.name}' vs '${base.name}')`);
      }
    }
  }

  // ---- SEPARATE onboarding page context -------------------------------------
  let onboarding = null;
  const olist = byProject.get(onboardProject);
  if (!olist || olist.length === 0) {
    problems.push(`onboarding project '${onboardProject}' page context was NOT observed (the separate onboarding page context is required)`);
  } else {
    for (const o of olist) for (const p of profileProblems(profileOf(o), { label: `onboarding project '${onboardProject}'` })) problems.push(p);
    const first = profileOf(olist[0]);
    for (const o of olist.slice(1)) {
      if (key(profileOf(o)) !== key(first)) problems.push('onboarding page contexts DISAGREE between captures');
    }
    onboarding = first;
  }

  // ---- the clock must be the ACTUAL applied fixed clock ---------------------
  const declaredClock = DECLARED_RENDER_CONTEXT.fixedClock;
  for (const rp of routeProfiles) {
    if (canonicalFixedClock(rp.fixedClock) && rp.fixedClock !== declaredClock) {
      problems.push(`route project '${rp.name}' observed clock ${JSON.stringify(rp.fixedClock)} != the applied fixed clock ${JSON.stringify(declaredClock)}`);
    }
  }
  if (onboarding && canonicalFixedClock(onboarding.fixedClock) && onboarding.fixedClock !== declaredClock) {
    problems.push(`onboarding observed clock ${JSON.stringify(onboarding.fixedClock)} != the applied fixed clock ${JSON.stringify(declaredClock)}`);
  }

  // ---- route viewports must be exactly the resolved project viewports --------
  if (routeProfiles.length) {
    const observed = routeProfiles.map((rp) => ({ name: rp.name, width: rp.viewport ? rp.viewport.width : undefined, height: rp.viewport ? rp.viewport.height : undefined }));
    for (const p of projectViewportProblems(observed)) problems.push(p);
  }

  if (problems.length) return { problems, context: null };

  const viewports = routeProjects.map((name) => {
    const rp = routeProfiles.find((r) => r.name === name);
    return { name, width: rp.viewport.width, height: rp.viewport.height };
  });
  const base = routeProfiles[0];
  return {
    problems: [],
    context: {
      viewports,
      colorScheme: base.colorScheme,
      mediaType: base.mediaType,
      locale: base.locale,
      timezone: base.timezone,
      deviceScaleFactor: base.deviceScaleFactor,
      reducedMotion: base.reducedMotion,
      fixedClock: base.fixedClock,
      onboarding: {
        viewport: { width: onboarding.viewport.width, height: onboarding.viewport.height },
        colorScheme: onboarding.colorScheme,
        mediaType: onboarding.mediaType,
        locale: onboarding.locale,
        timezone: onboarding.timezone,
        deviceScaleFactor: onboarding.deviceScaleFactor,
        reducedMotion: onboarding.reducedMotion,
        fixedClock: onboarding.fixedClock,
      },
      observedCount: doc.observations.length,
    },
  };
}
