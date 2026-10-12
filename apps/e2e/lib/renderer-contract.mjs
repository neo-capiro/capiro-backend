/**
 * Pure renderer / rendering-context contract (CleanUp1 §8.5, root review round
 * 60.4).
 *
 * The visual lane's "are these two runs the same renderer?" question used to be
 * answered by comparing only browserVersion / launched-binary sha /
 * image digest / font-list sha. That is NOT the complete determinism contract:
 * the OS/runtime, the launched executable AND its headless-shell identity, the
 * font FILES (not just the sorted-path list), the pinned image digest and the
 * whole browser CONTEXT (locale, timezone, device scale factor, reduced motion,
 * fixed clock) all decide the rendered bytes.
 *
 * This module is the ONE canonical comparison/validation kernel. It is imported
 * by the regression driver, the strict same-source repeat proof and the gate's
 * pinned-visual validator, so there is no second divergent kernel.
 *
 * It is PURE: it never launches a browser and reads no files. The `runtime`
 * value it canonicalises comes from the REAL recorder
 * (apps/e2e/lib/runtime-identity.mjs `captureRuntimeIdentity()`), which is the
 * only producer of these fields.
 *
 * An INCOMPLETE runtime (`rendererContractProblems` non-empty) must REFUSE; the
 * kernel never fills a guessed default for a missing field.
 */

import { createHash } from 'node:crypto';
import { canonicalViewports, projectViewportProblems } from './render-context.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function isHex64(v) {
  return typeof v === 'string' && HEX64.test(v);
}

/**
 * Canonicalise the SEPARATE onboarding page context (a single resolved
 * viewport + the same context fields). Returns null when the shape is
 * absent/malformed, so an unobserved onboarding context can never be coerced
 * into a guessable default.
 */
export function canonicalOnboarding(v) {
  if (!v || typeof v !== 'object') return null;
  const vp = v.viewport;
  if (!vp || !Number.isInteger(vp.width) || vp.width <= 0 || !Number.isInteger(vp.height) || vp.height <= 0) return null;
  return {
    viewport: { width: vp.width, height: vp.height },
    colorScheme: typeof v.colorScheme === 'string' ? v.colorScheme : null,
    mediaType: typeof v.mediaType === 'string' ? v.mediaType : null,
    locale: typeof v.locale === 'string' ? v.locale : null,
    timezone: typeof v.timezone === 'string' ? v.timezone : null,
    deviceScaleFactor: typeof v.deviceScaleFactor === 'number' ? v.deviceScaleFactor : null,
    reducedMotion: typeof v.reducedMotion === 'boolean' ? v.reducedMotion : null,
    fixedClock: typeof v.fixedClock === 'string' ? v.fixedClock : null,
  };
}

/**
 * Digest over the ACTUAL font files (path + content sha), order-independent.
 * This is stricter than the sorted-path list sha: two font stacks with the same
 * file NAMES but different font BYTES must not compare equal.
 *
 * Returns `null` (never a plausible-but-meaningless 64-hex digest) when the list
 * is missing/empty or any member lacks a non-empty path or a 64-hex sha256 — so
 * an empty `fonts.files` or a malformed member can never hash to something that
 * passes the completeness check.
 */
export function fontFilesDigest(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const lines = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0) return null;
    if (!isHex64(f.sha256)) return null;
    lines.push(`${f.path}\u0000${f.sha256}`);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The complete renderer/context contract, in a FIXED key order, extracted from
 * an actual runtime identity record. `null` is used for a genuinely absent
 * field — never a guessed default.
 */
export function rendererContract(runtime) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const fonts = rt.fonts && typeof rt.fonts === 'object' ? rt.fonts : {};
  const launched = rt.launchedBrowser && typeof rt.launchedBrowser === 'object' ? rt.launchedBrowser : {};
  const image = rt.image && typeof rt.image === 'object' ? rt.image : {};
  return {
    os: typeof rt.os === 'string' ? rt.os : null,
    node: typeof rt.node === 'string' ? rt.node : null,
    browserVersion: typeof rt.browserVersion === 'string' ? rt.browserVersion : null,
    launchedBrowserSha256: isHex64(launched.sha256) ? launched.sha256 : null,
    launchedBrowserHeadlessShell: typeof launched.isHeadlessShell === 'boolean' ? launched.isHeadlessShell : null,
    imageDigest: typeof image.digest === 'string' ? image.digest : null,
    fontSource: typeof fonts.source === 'string' ? fonts.source : null,
    fontCount: Number.isInteger(fonts.count) ? fonts.count : null,
    fontListSha256: isHex64(fonts.listSha256) ? fonts.listSha256 : null,
    fontFilesDigest: fontFilesDigest(fonts.files),
    // The ACTUAL browser context the pixels were rendered in. Without these the
    // determinism question (layout/pixels) is unanswerable.
    colorScheme: typeof rt.colorScheme === 'string' ? rt.colorScheme : null,
    mediaType: typeof rt.mediaType === 'string' ? rt.mediaType : null,
    viewports: canonicalViewports(rt.viewports),
    locale: typeof rt.locale === 'string' ? rt.locale : null,
    timezone: typeof rt.timezone === 'string' ? rt.timezone : null,
    deviceScaleFactor: typeof rt.deviceScaleFactor === 'number' ? rt.deviceScaleFactor : null,
    reducedMotion: typeof rt.reducedMotion === 'boolean' ? rt.reducedMotion : null,
    fixedClock: typeof rt.fixedClock === 'string' ? rt.fixedClock : null,
    // The SEPARATE onboarding page context (apps/onboard-web) — its own observed
    // viewport + context. Never derived from the route projects.
    onboarding: canonicalOnboarding(rt.onboarding),
  };
}

/**
 * Problems for an incomplete/invalid renderer contract (empty list = complete).
 * A caller MUST refuse when this is non-empty; it must never coerce a partial
 * runtime into a guessable default.
 */
export function rendererContractProblems(runtime, { label = 'renderer' } = {}) {
  const problems = [];
  const c = rendererContract(runtime);
  const push = (m) => problems.push(`${label}: ${m}`);
  if (!c.os) push('os missing (actual platform environment not recorded)');
  if (!c.node) push('node version missing');
  if (!c.browserVersion) push('browserVersion missing');
  if (!isHex64(c.launchedBrowserSha256)) push('launchedBrowser.sha256 must be 64-hex (actual launched binary not recorded)');
  if (c.launchedBrowserHeadlessShell === null) push('launchedBrowser.isHeadlessShell missing (headless-shell identity not recorded)');
  if (!IMAGE_DIGEST.test(String(c.imageDigest))) push('image.digest must be a pinned sha256:<64hex> digest');
  if (!c.fontSource) push('fonts.source missing');
  // fontCount is the actual fontconfig (fc-list) count; it is validated as a
  // positive integer but deliberately NOT required to equal fonts.files.length
  // (fc-list rows can differ from the unique-hashed file set).
  if (!Number.isInteger(c.fontCount) || c.fontCount <= 0) push('fonts.count must be a positive integer');
  if (!isHex64(c.fontListSha256)) push('fonts.listSha256 must be 64-hex');
  if (!isHex64(c.fontFilesDigest)) push('fonts.files digest missing (no actual non-empty font files with real path+sha256 recorded)');
  // The complete rendering context: colour scheme, media type and the three
  // ACTUAL project viewports.
  if (!c.colorScheme) push('colorScheme missing (actual browser colour-scheme context not recorded)');
  if (!c.mediaType) push('mediaType missing (actual browser media type not recorded)');
  for (const p of projectViewportProblems(runtime && typeof runtime === 'object' ? runtime.viewports : null)) push(p);
  if (!c.locale) push('locale missing');
  if (!c.timezone) push('timezone missing');
  if (!Number.isFinite(c.deviceScaleFactor) || c.deviceScaleFactor <= 0) push('deviceScaleFactor missing');
  if (typeof c.reducedMotion !== 'boolean') push('reducedMotion missing');
  if (!c.fixedClock) push('fixedClock missing');
  // The SEPARATE onboarding page context must be observed and coherent with the
  // route context (same clock/locale/colour scheme/media/DPR/motion).
  if (!c.onboarding) {
    push('onboarding page context missing (the separate onboarding page context was not observed)');
  } else {
    const ob = c.onboarding;
    if (!ob.colorScheme) push('onboarding colorScheme missing');
    if (!ob.mediaType) push('onboarding mediaType missing');
    if (!ob.locale) push('onboarding locale missing');
    if (!ob.timezone) push('onboarding timezone missing');
    if (!Number.isFinite(ob.deviceScaleFactor) || ob.deviceScaleFactor <= 0) push('onboarding deviceScaleFactor missing');
    if (typeof ob.reducedMotion !== 'boolean') push('onboarding reducedMotion missing');
    if (!ob.fixedClock) push('onboarding fixedClock missing');
    if (c.fixedClock && ob.fixedClock && ob.fixedClock !== c.fixedClock) push('onboarding fixedClock differs from the route fixedClock');
    if (c.colorScheme && ob.colorScheme && ob.colorScheme !== c.colorScheme) push('onboarding colorScheme differs from the route colorScheme');
    if (c.mediaType && ob.mediaType && ob.mediaType !== c.mediaType) push('onboarding mediaType differs from the route mediaType');
    if (c.locale && ob.locale && ob.locale !== c.locale) push('onboarding locale differs from the route locale');
    if (c.timezone && ob.timezone && ob.timezone !== c.timezone) push('onboarding timezone differs from the route timezone');
    if (Number.isFinite(c.deviceScaleFactor) && Number.isFinite(ob.deviceScaleFactor) && ob.deviceScaleFactor !== c.deviceScaleFactor) push('onboarding deviceScaleFactor differs from the route deviceScaleFactor');
    if (typeof c.reducedMotion === 'boolean' && typeof ob.reducedMotion === 'boolean' && ob.reducedMotion !== c.reducedMotion) push('onboarding reducedMotion differs from the route reducedMotion');
  }
  return problems;
}

/** Order-stable canonical serialization of the complete contract. */
export function rendererCanonical(runtime) {
  return JSON.stringify(rendererContract(runtime));
}

/** True only when BOTH runtimes carry a COMPLETE, identical contract. */
export function sameRenderer(a, b) {
  if (rendererContractProblems(a, { label: 'renderer' }).length > 0) return false;
  if (rendererContractProblems(b, { label: 'baseline renderer' }).length > 0) return false;
  return rendererCanonical(a) === rendererCanonical(b);
}

/**
 * The renderer-binding problems for a run against the baseline renderer. Both
 * the run runtime AND the baseline runtime must be COMPLETE, and equal; an
 * incomplete runtime on either side is a refusal, never a guess.
 */
export function rendererBindingProblems(runRuntime, baselineRuntime) {
  const problems = [];
  for (const p of rendererContractProblems(runRuntime, { label: 'run renderer' })) problems.push(p);
  for (const p of rendererContractProblems(baselineRuntime, { label: 'baseline renderer' })) problems.push(p);
  if (problems.length === 0 && rendererCanonical(runRuntime) !== rendererCanonical(baselineRuntime)) {
    problems.push('renderer mismatch: the run renderer/context does not equal the baseline renderer/context');
  }
  return problems;
}
