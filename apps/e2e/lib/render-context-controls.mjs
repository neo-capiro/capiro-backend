#!/usr/bin/env node
/**
 * Render-context PURE controls (CleanUp1 §8.5, round 73 / root review round 80).
 *
 * These exercise the REAL render-context aggregation kernel in
 * apps/e2e/lib/render-context.mjs against ACTUAL observation shapes — NOT a mock
 * of Playwright. They prove the aggregator REFUSES a missing route project, a
 * missing onboarding context, a disagreement between projects/captures, a
 * malformed profile field, an empty observation set, and a clock that is not the
 * ACTUAL applied fixed clock — i.e. the exact holes the round-73 review named in
 * the old synthetic-context recorder.
 *
 * Round-80 additions: the recording helpers themselves are fail-closed — a
 * malformed EXISTING observation document is refused (never silently reset, which
 * would discard other pages' observations) and a page that cannot be observed is
 * a hard failure when a producer supplied an observation path. These are
 * malformed-file / record-failure controls over the REAL helpers; no synthetic
 * page context is ever substituted for a real render.
 *
 *   node apps/e2e/lib/render-context-controls.mjs
 * Exit: 0 all controls pass; 1 any control failed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateRenderContext,
  canonicalViewports,
  projectViewportProblems,
  profileProblems,
  appendRenderObservation,
  readRenderObservations,
  recordRenderObservation,
  ROUTE_PROJECT_NAMES,
  ONBOARD_PROJECT_NAME,
} from './render-context.mjs';
import { FIXED_CLOCK_ISO } from './projects.mjs';

const results = [];
let failures = 0;
async function control(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === 'object' && r.detail) detail = r.detail;
  } catch (e) {
    ok = false;
    detail = `threw: ${e.message}`;
  }
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** One ACTUAL page-context observation record, as the spec would write it. */
function obs(project, over = {}) {
  return {
    project,
    phase: 'regression',
    observedAt: '2026-10-07T12:00:01.000Z',
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    mediaType: 'screen',
    locale: 'en-US',
    timezone: 'America/New_York',
    deviceScaleFactor: 1,
    reducedMotion: true,
    fixedClock: FIXED_CLOCK_ISO,
    ...over,
  };
}

function fullDoc() {
  return {
    schema: 'capiro.cleanup1.render-context-observations.v1',
    observations: [
      obs('desktop-1440', { viewport: { width: 1440, height: 1000 } }),
      obs('tablet-1024', { viewport: { width: 1024, height: 1000 } }),
      obs('mobile-390', { viewport: { width: 390, height: 844 } }),
      obs('onboard-desktop-1440', { viewport: { width: 1440, height: 1000 }, phase: 'onboard-smoke' }),
    ],
  };
}

// ---- positive --------------------------------------------------------------
await control('a COMPLETE observation set aggregates to the complete render context', () => {
  const agg = aggregateRenderContext(fullDoc());
  return {
    ok:
      agg.problems.length === 0 &&
      agg.context !== null &&
      agg.context.fixedClock === FIXED_CLOCK_ISO &&
      agg.context.viewports.length === ROUTE_PROJECT_NAMES.length &&
      agg.context.onboarding &&
      agg.context.onboarding.viewport.width === 1440,
    detail: agg.problems.join('; '),
  };
});

// ---- missing / empty -------------------------------------------------------
await control('an EMPTY observation set is refused', () => {
  const agg = aggregateRenderContext({ schema: 'capiro.cleanup1.render-context-observations.v1', observations: [] });
  return { ok: agg.context === null && agg.problems.some((p) => /page context was NOT observed|page context was not observed/.test(p)) };
});
await control('a MISSING route project is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.filter((o) => o.project !== 'tablet-1024');
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /route project 'tablet-1024'.*NOT observed/.test(p)) };
});
await control('a MISSING onboarding context is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.filter((o) => o.project !== ONBOARD_PROJECT_NAME);
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /onboarding project .*NOT observed/.test(p)) };
});
await control('a MISSING/malformed observations array is refused', () => {
  return { ok: aggregateRenderContext({ schema: 'capiro.cleanup1.render-context-observations.v1' }).context === null };
});

// ---- disagreement ----------------------------------------------------------
await control('DISAGREEMENT between route projects (colour scheme) is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.map((o) => (o.project === 'tablet-1024' ? { ...o, colorScheme: 'dark' } : o));
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /DISAGREE on colorScheme/.test(p)) };
});
await control('DISAGREEMENT between captures of the SAME project is refused', () => {
  const d = fullDoc();
  d.observations.push(obs('desktop-1440', { viewport: { width: 1440, height: 1000 }, locale: 'fr-FR' }));
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /route project 'desktop-1440' page contexts DISAGREE/.test(p)) };
});

// ---- malformed profile -----------------------------------------------------
await control('a MALFORMED profile (missing timezone) is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.map((o) => (o.project === 'mobile-390' ? { ...o, timezone: null } : o));
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /timezone missing/.test(p)) };
});
await control('profileProblems flags a missing fixedClock', () => {
  return { ok: profileProblems({ viewport: { width: 10, height: 10 }, colorScheme: 'light', mediaType: 'screen', locale: 'en-US', timezone: 'UTC', deviceScaleFactor: 1, reducedMotion: true }).some((p) => /fixedClock/.test(p)) };
});

// ---- clock -----------------------------------------------------------------
await control('a clock that is NOT the applied fixed clock is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.map((o) => ({ ...o, fixedClock: '2026-10-07T13:00:00.000Z' }));
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /!= the applied fixed clock/.test(p)) };
});
await control('a malformed (non-ISO) clock is refused', () => {
  const d = fullDoc();
  d.observations = d.observations.map((o) => (o.project === 'desktop-1440' ? { ...o, fixedClock: 'not-a-clock' } : o));
  const agg = aggregateRenderContext(d);
  return { ok: agg.context === null && agg.problems.some((p) => /fixedClock missing\/malformed/.test(p)) };
});

// ---- viewport helpers ------------------------------------------------------
await control('canonicalViewports rejects an empty/malformed list', () => {
  return { ok: canonicalViewports([]) === null && canonicalViewports([{ name: 'x', width: 0, height: 10 }]) === null };
});
await control('projectViewportProblems rejects a wrong observed dimension', () => {
  return { ok: projectViewportProblems([{ name: 'desktop-1440', width: 1441, height: 1000 }]).some((p) => /!= resolved/.test(p)) };
});

// ---- observation recording (REAL helpers, malformed-file / failure controls) -
const tmpDirs = [];
function tmpObsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-obs-'));
  tmpDirs.push(dir);
  return dir;
}

await control('appendRenderObservation REFUSES a malformed existing file (no silent reset)', () => {
  const file = path.join(tmpObsDir(), 'observations.json');
  const malformed = '{ "schema": "capiro.cleanup1.render-context-observations.v1", "observations": [';
  fs.writeFileSync(file, malformed, 'utf8');
  let threw = false;
  try {
    appendRenderObservation(file, obs('desktop-1440'));
  } catch {
    threw = true;
  }
  // The malformed bytes must be left UNTOUCHED (refused, not reset).
  return { ok: threw && fs.readFileSync(file, 'utf8') === malformed };
});

await control('appendRenderObservation REFUSES a wrong-schema existing file (no silent reset)', () => {
  const file = path.join(tmpObsDir(), 'observations.json');
  const foreign = JSON.stringify({ schema: 'some.other.schema.v1', observations: [] });
  fs.writeFileSync(file, foreign, 'utf8');
  let threw = false;
  try {
    appendRenderObservation(file, obs('desktop-1440'));
  } catch {
    threw = true;
  }
  return { ok: threw && fs.readFileSync(file, 'utf8') === foreign };
});

await control('appendRenderObservation preserves earlier observations (read-modify-write)', () => {
  const file = path.join(tmpObsDir(), 'observations.json');
  appendRenderObservation(file, obs('desktop-1440'));
  appendRenderObservation(file, obs('tablet-1024'));
  const read = readRenderObservations(file);
  return { ok: read.ok === true && read.doc.observations.length === 2 };
});

await control('readRenderObservations REFUSES malformed JSON', () => {
  const file = path.join(tmpObsDir(), 'observations.json');
  fs.writeFileSync(file, 'not json at all', 'utf8');
  const read = readRenderObservations(file);
  return { ok: read.ok === false && /not valid JSON/.test(read.error) };
});

await control('recordRenderObservation FAILS CLOSED when the page cannot be observed', async () => {
  const file = path.join(tmpObsDir(), 'observations.json');
  const failingPage = { evaluate: async () => { throw new Error('page context unavailable'); } };
  let threw = false;
  try {
    await recordRenderObservation({ file, phase: 'capture', project: 'desktop-1440', page: failingPage });
  } catch {
    threw = true;
  }
  // Nothing may have been written when the observation failed.
  return { ok: threw && !fs.existsSync(file) };
});

await control('recordRenderObservation is a no-op with no observation path', async () => {
  const r = await recordRenderObservation({ file: '', phase: 'capture', project: 'desktop-1440', page: null });
  return { ok: r === false };
});

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.stdout.write(`\n[render-context-controls] ${results.length - failures}/${results.length} controls passed\n`);
if (failures > 0) {
  process.stderr.write(`[render-context-controls] ${failures} control(s) FAILED\n`);
  process.exit(1);
}
process.stdout.write('[render-context-controls] ALL PASS\n');
