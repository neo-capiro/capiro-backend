#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as chromeLauncher from 'chrome-launcher';
import { connectChrome, createActor } from './phase19-cdp.mjs';

const BASE_URL = (process.env.PHASE19_BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const FIXTURE_FILE = process.env.PHASE19_FIXTURE_FILE ?? '/tmp/meriv2-phase19-fixtures.json';
const EVIDENCE_DIR = process.env.PHASE19_EVIDENCE_DIR ?? '/tmp/meriv2-phase19-browser-evidence';
const SHA = process.env.GITHUB_SHA ?? process.env.PHASE19_SHA ?? 'unknown';
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'desktop-1024x768', width: 1024, height: 768 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const results = [];
let failed = 0;
let blocked = 0;

async function scenario(name, actor, scope, run, expected = 'pass') {
  const started = new Date().toISOString();
  try {
    const actual = await run();
    const screenshot = await actor.screenshot(`${name}-${actor.label}`);
    results.push({ name, actor: actor.label, scope, status: 'passed', expected, actual, started, screenshot });
    console.log(`PASS ${name}`);
    return actual;
  } catch (error) {
    failed += 1;
    let screenshot = null;
    try {
      screenshot = await actor.screenshot(`${name}-${actor.label}-failed`);
    } catch {}
    const actual = error instanceof Error ? error.message : String(error);
    results.push({ name, actor: actor.label, scope, status: 'failed', expected, actual, started, screenshot });
    console.error(`FAIL ${name}: ${actual}`);
    return null;
  }
}

function recordBlocked(name, actor, scope, reason) {
  blocked += 1;
  results.push({
    name,
    actor,
    scope,
    status: 'blocked',
    expected: 'authenticated live scenario',
    actual: reason,
    started: new Date().toISOString(),
    screenshot: null,
  });
  console.error(`BLOCKED ${name}: ${reason}`);
}

async function openQueue(page) {
  await page.navigate('/settings/memory');
  const hasPendingTab = await page.evaluate(`[...document.querySelectorAll('[role="tab"]')]
    .some((node) => (node.textContent || '').trim().startsWith('Pending review'))`);
  if (hasPendingTab) await page.clickText('Pending review', false);
}

async function openGovernanceTab(page, label) {
  await page.navigate('/settings/memory');
  await page.clickText(label, false);
}

async function focusAndClick(page, text) {
  const clicked = await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const node = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.offsetParent !== null &&
        (candidate.textContent || '').replace(/\\s+/g, ' ').trim() === wanted);
    if (!node) return false;
    node.focus();
    node.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not focus and click ${text}`);
}

async function assertDialogFocusTrap(page, expectedReturnLabel) {
  await page.waitFor(() =>
    page.evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`),
  );
  const count = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    return dialog ? [...dialog.querySelectorAll('button,input,textarea,select,[tabindex]')]
      .filter((node) => node.offsetParent !== null && !node.disabled && node.tabIndex >= 0).length : 0;
  })()`);
  if (count < 2) throw new Error('Dialog did not expose enough focusable controls');
  for (let i = 0; i < count + 2; i += 1) await page.tab();
  const trapped = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    return Boolean(dialog && dialog.contains(document.activeElement));
  })()`);
  if (!trapped) throw new Error('Keyboard focus escaped the modal dialog');
  return async () => {
    await page.waitFor(() =>
      page.evaluate(`!document.querySelector('[role="dialog"][aria-modal="true"]')`),
    );
    await page.waitFor(() =>
      page.evaluate(`(document.activeElement?.textContent || '')
        .replace(/\\s+/g, ' ').trim() === ${JSON.stringify(expectedReturnLabel)}`),
    );
  };
}

function auditPassed(audit) {
  return (
    audit.duplicates.length === 0 &&
    audit.brokenLabelledBy.length === 0 &&
    audit.unnamed.length === 0 &&
    audit.unnamedAx.length === 0 &&
    audit.clipped.length === 0 &&
    audit.overflow === false
  );
}

async function livePreparedState(page, name, pathEnv, expectedEnv, scope) {
  const pathname = process.env[pathEnv]?.trim();
  const expectedText = process.env[expectedEnv]?.trim();
  if (!pathname || !expectedText) {
    recordBlocked(name, page.label, scope, `${pathEnv} and ${expectedEnv} are required`);
    return;
  }
  await scenario(name, page, scope, async () => {
    await page.navigate(pathname);
    await page.waitText(expectedText, 60_000);
    const before = await page.audit();
    await page.reload();
    await page.waitText(expectedText, 30_000);
    return { path: pathname, expectedText, persistedAfterReload: true, accessibility: before };
  });
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const fixtures = JSON.parse(await readFile(FIXTURE_FILE, 'utf8'));
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  try {
    const cdp = await connectChrome(chrome.port);
    const actorInput = {
      cdp,
      orgId: fixtures.tenant.clerkOrgId,
      baseUrl: BASE_URL,
      evidenceDir: EVIDENCE_DIR,
    };
    const proposer = await createActor({
      ...actorInput,
      label: 'proposer-admin',
      cookie: required('PHASE19_PROPOSER_COOKIE'),
    });
    const reviewer = await createActor({
      ...actorInput,
      label: 'independent-reviewer',
      cookie: required('PHASE19_REVIEWER_COOKIE'),
    });
    const clientReviewer = await createActor({
      ...actorInput,
      label: 'client-granted-reviewer',
      cookie: required('PHASE19_CLIENT_REVIEWER_COOKIE'),
    });
    const denied = await createActor({
      ...actorInput,
      label: 'ethical-wall-denied-user',
      cookie: required('PHASE19_DENIED_COOKIE'),
    });

    const privateMarker = `Phase 19 private save ${SHA.slice(0, 12)}`;
    await scenario('memory-private-save-and-reload', proposer, 'user-private', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('My files');
      await proposer.waitText('Save changes');
      await proposer.fillFirstEditableTextarea(privateMarker);
      await proposer.clickText('Save changes');
      await proposer.waitText('Saved');
      await proposer.reload();
      await proposer.clickText('My files');
      await proposer.waitText(privateMarker);
      return { persisted: true, marker: privateMarker };
    });

    const sharedMarker = `Phase 19 shared proposal ${SHA.slice(0, 12)}`;
    const sharedCandidate = await scenario('memory-shared-proposal', proposer, 'firm', async () => {
      await proposer.navigate('/settings/memory');
      await proposer.clickText('Firm');
      await proposer.waitText('Submit for review');
      await proposer.fillFirstEditableTextarea(sharedMarker);
      await proposer.clickText('Submit for review');
      await proposer.waitText('Submitted for independent review');
      const body = await proposer.bodyText();
      const candidateId = body.match(/Candidate\s+([0-9a-f-]{36})/i)?.[1];
      if (!candidateId) throw new Error('Shared proposal candidate ID was not rendered');
      return { candidateId, marker: sharedMarker };
    });

    if (sharedCandidate?.candidateId) {
      await scenario('memory-independent-approval', reviewer, 'firm', async () => {
        await openQueue(reviewer);
        await reviewer.waitText(sharedMarker);
        await reviewer.clickWithin(sharedMarker, 'Approve');
        await reviewer.waitText('Memory approved');
        return { candidateId: sharedCandidate.candidateId, approved: true };
      });
      await scenario('memory-approved-content-reload', proposer, 'firm', async () => {
        await proposer.navigate('/settings/memory');
        await proposer.clickText('Firm');
        await proposer.waitText(sharedMarker);
        return { activeContentUpdated: true };
      });
    }

    await scenario('memory-client-granted-reviewer', clientReviewer, 'client', async () => {
      await openQueue(clientReviewer);
      await clientReviewer.waitText('Phase 19 Client Reviewer Candidate');
      await clientReviewer.clickWithin('Phase 19 Client Reviewer Candidate', 'Approve');
      await clientReviewer.waitText('Memory approved');
      return { candidateId: fixtures.candidates.pendingClient, approved: true };
    });

    await scenario('memory-ethical-wall-denied-response', denied, 'client', async () => {
      const detail = await denied.api(
        `/api/memory/governance/items/${fixtures.items.approvedClientItemId}`,
      );
      const queue = await denied.api('/api/memory/review/candidates');
      const secretText = 'Phase 19 confidential approved client memory';
      if (![403, 404].includes(detail.status)) {
        throw new Error(`Expected denied detail status, received ${detail.status}`);
      }
      if (detail.text.toLowerCase().includes(secretText.toLowerCase())) {
        throw new Error('Denied detail response leaked confidential content');
      }
      if (
        queue.text.includes(fixtures.candidates.pendingClient) ||
        queue.text.includes('Phase 19 Client Reviewer Candidate')
      ) {
        throw new Error('Denied review queue leaked client proposal identity');
      }
      return { detailStatus: detail.status, queueStatus: queue.status, confidentialLeak: false };
    });

    await scenario('memory-proposer-withdrawal', proposer, 'firm', async () => {
      await openQueue(proposer);
      await proposer.waitText('Phase 19 proposer withdrawal marker.');
      await proposer.clickWithin('Phase 19 proposer withdrawal marker.', 'Withdraw');
      await proposer.waitText('Proposal withdrawn');
      await openQueue(proposer);
      await proposer.waitText('Withdrawn');
      return { candidateId: fixtures.candidates.withdraw, status: 'withdrawn' };
    });

    await scenario('memory-reviewer-rejection', reviewer, 'firm', async () => {
      await openQueue(reviewer);
      await reviewer.waitText('Phase 19 reviewer rejection marker.');
      await reviewer.clickWithin('Phase 19 reviewer rejection marker.', 'Reject');
      await reviewer.waitText('Memory rejected');
      return { candidateId: fixtures.candidates.reject, status: 'rejected' };
    });
    await scenario('memory-rejection-visible-to-proposer', proposer, 'firm', async () => {
      await openQueue(proposer);
      await proposer.waitText('Rejected by reviewer');
      return { label: 'Rejected by reviewer' };
    });

    await scenario('memory-conflict-resolution', reviewer, 'firm', async () => {
      await openGovernanceTab(reviewer, 'Conflicts');
      await reviewer.clickAria(`Open memory ${fixtures.items.correctionBase.title}`);
      await reviewer.waitText('Resolve conflict');
      await reviewer.clickText('Resolve conflict');
      await reviewer.selectByLabel('Controlling memory', fixtures.items.correctionBase.title);
      await reviewer.fillByLabel(
        'Reason',
        'Phase 19 selects a reviewed controlling version for this conflict.',
      );
      await reviewer.clickText('Submit');
      await reviewer.waitText('Resolve memory conflict completed');
      return { conflictGroupId: fixtures.items.conflictGroupId, resolved: true };
    });

    const correctionMarker = `Phase 19 corrected content ${SHA.slice(0, 12)}`;
    await scenario('memory-correction-proposal-and-focus', proposer, 'firm', async () => {
      await openGovernanceTab(proposer, 'Active');
      await proposer.clickAria(`Open memory ${fixtures.items.firm.title}`);
      await proposer.waitText('Suggest correction');
      await focusAndClick(proposer, 'Suggest correction');
      const assertFocusReturn = await assertDialogFocusTrap(proposer, 'Suggest correction');
      await proposer.fillByLabel('Corrected memory', correctionMarker);
      await proposer.clickText('Submit');
      await proposer.waitText('Proposal submitted for independent review');
      await assertFocusReturn();
      return { marker: correctionMarker, focusTrap: true, focusReturned: true };
    });
    await scenario('memory-correction-approval', reviewer, 'firm', async () => {
      await openQueue(reviewer);
      await reviewer.waitText(correctionMarker);
      await reviewer.clickWithin(correctionMarker, 'Approve');
      await reviewer.waitText('Memory version activated');
      return { activated: true };
    });

    await scenario('memory-legal-hold-controls', reviewer, 'firm', async () => {
      await openGovernanceTab(reviewer, 'Active');
      await reviewer.clickAria(`Open memory ${fixtures.items.legalHold.title}`);
      await reviewer.waitText('Legal hold');
      const body = await reviewer.bodyText();
      const buttons = await reviewer.visibleButtonLabels();
      if (!body.includes('Yes')) throw new Error('Legal hold detail did not render Yes');
      if (buttons.includes('Revoke') || buttons.includes('Suggest correction')) {
        throw new Error('Legal-held item exposed destructive controls');
      }
      return { destructiveControlsHidden: true };
    });

    await scenario('memory-revoke', proposer, 'firm', async () => {
      await openGovernanceTab(proposer, 'Active');
      await proposer.clickAria(`Open memory ${fixtures.items.revokeRestore.title}`);
      await proposer.clickText('Revoke');
      await proposer.fillByLabel('Reason', 'Phase 19 reversible browser revoke.');
      await proposer.clickText('Revoke memory');
      await proposer.waitText('Revoke memory completed');
      return { revoked: true };
    });
    await scenario('memory-restore-as-new-version', proposer, 'firm', async () => {
      await openGovernanceTab(proposer, 'History');
      await proposer.clickAria(`Open memory ${fixtures.items.revokeRestore.title}`);
      await proposer.clickText('Restore as new version');
      await proposer.waitText('Proposal submitted for independent review');
      return { restoreProposed: true };
    });
    await scenario('memory-restore-approval', reviewer, 'firm', async () => {
      await openQueue(reviewer);
      await reviewer.waitText(fixtures.items.revokeRestore.title);
      await reviewer.clickWithin(fixtures.items.revokeRestore.title, 'Approve');
      await reviewer.waitText('Memory version activated');
      return { restored: true };
    });

    await scenario('memory-projection-failure-retry', reviewer, 'firm', async () => {
      await openGovernanceTab(reviewer, 'Projection health');
      await reviewer.waitText('Projection work needs attention');
      await reviewer.clickWithin(fixtures.items.revokeRestore.title, 'Retry');
      await reviewer.waitText('Projection retry queued');
      return { jobId: fixtures.projectionJobId, retryQueued: true };
    });

    for (const viewport of VIEWPORTS) {
      await reviewer.setViewport(viewport.width, viewport.height);
      await reviewer.navigate('/settings/memory');
      const audit = await reviewer.audit();
      const screenshot = await reviewer.screenshot(`authenticated-memory-${viewport.name}`);
      const status = auditPassed(audit) ? 'passed' : 'failed';
      if (status === 'failed') failed += 1;
      results.push({
        name: `viewport-authenticated-memory-${viewport.name}`,
        actor: reviewer.label,
        scope: fixtures.tenant.slug,
        status,
        expected:
          'no duplicate IDs, broken relationships, unnamed controls, clipped actions, or page overflow',
        actual: audit,
        started: new Date().toISOString(),
        screenshot,
      });
    }

    await reviewer.setReducedMotion();
    await scenario('context-inspector-keyboard-and-confidentiality', reviewer, 'supplemental fixture', async () => {
      await reviewer.navigate('/context-inspector-a11y-fixture.html');
      const audit = await reviewer.audit();
      if (
        audit.duplicates.length ||
        audit.brokenLabelledBy.length ||
        audit.unnamedAx.length ||
        audit.restrictedLeak
      ) {
        throw new Error(JSON.stringify(audit));
      }
      const disclosure = await reviewer.evaluate(`(() => {
        const node = document.querySelector('[aria-expanded]');
        if (!node) return null;
        node.focus();
        return { before: node.getAttribute('aria-expanded') };
      })()`);
      if (!disclosure) throw new Error('Context Inspector disclosure was not found');
      await reviewer.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Enter', code: 'Enter' },
        reviewer.sessionId,
      );
      await reviewer.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Enter', code: 'Enter' },
        reviewer.sessionId,
      );
      const afterEnter = await reviewer.evaluate(
        `document.activeElement?.getAttribute('aria-expanded')`,
      );
      if (afterEnter === disclosure.before) throw new Error('Enter did not toggle Context Inspector');
      await reviewer.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: ' ', code: 'Space' },
        reviewer.sessionId,
      );
      await reviewer.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: ' ', code: 'Space' },
        reviewer.sessionId,
      );
      const afterSpace = await reviewer.evaluate(
        `document.activeElement?.getAttribute('aria-expanded')`,
      );
      if (afterSpace !== disclosure.before) throw new Error('Space did not restore disclosure state');
      const reduced = await reviewer.evaluate(
        `matchMedia('(prefers-reduced-motion: reduce)').matches`,
      );
      if (!reduced) throw new Error('Reduced-motion emulation was not active');
      return { ...audit, enterToggle: true, spaceToggle: true, reducedMotion: true };
    });

    await scenario('assurance-state-browser-fixture', reviewer, 'supplemental fixture', async () => {
      await reviewer.navigate('/phase19-assurance-fixture.html');
      await reviewer.waitText('High-risk chat hold');
      await reviewer.clickText('Apply 2 selected');
      await reviewer.waitText('Applied locally; save failed.');
      await reviewer.clickText('Retry save');
      await reviewer.waitText('Applied and saved.');
      await reviewer.clickText('Retry failed sections');
      await reviewer.waitText('Retry completed; unsupported amount remains excluded.');
      const audit = await reviewer.audit();
      if (!auditPassed(audit)) throw new Error(JSON.stringify(audit));
      return audit;
    });

    await livePreparedState(
      reviewer,
      'context-inspector-after-authenticated-reload',
      'PHASE19_LIVE_CONTEXT_PATH',
      'PHASE19_LIVE_CONTEXT_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'context-shadow-behavior',
      'PHASE19_LIVE_SHADOW_PATH',
      'PHASE19_LIVE_SHADOW_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'context-enforce-behavior',
      'PHASE19_LIVE_ENFORCE_PATH',
      'PHASE19_LIVE_ENFORCE_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'high-risk-chat-hold',
      'PHASE19_LIVE_CHAT_PATH',
      'PHASE19_LIVE_CHAT_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'in-editor-held-edit',
      'PHASE19_LIVE_EDITOR_PATH',
      'PHASE19_LIVE_EDITOR_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'workspace-partial-generation-and-retry',
      'PHASE19_LIVE_WORKSPACE_PATH',
      'PHASE19_LIVE_WORKSPACE_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'strategy-steward-hold',
      'PHASE19_LIVE_STRATEGY_PATH',
      'PHASE19_LIVE_STRATEGY_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'export-acknowledgment',
      'PHASE19_LIVE_EXPORT_PATH',
      'PHASE19_LIVE_EXPORT_EXPECT',
      fixtures.tenant.slug,
    );
    await livePreparedState(
      reviewer,
      'proposal-card-policy-version',
      'PHASE19_LIVE_PROPOSAL_PATH',
      'PHASE19_LIVE_PROPOSAL_EXPECT',
      fixtures.tenant.slug,
    );

    if (!process.env.PHASE18_ACCEPTED_SHA?.trim()) {
      recordBlocked(
        'phase18-prerequisite',
        'release-gate',
        fixtures.tenant.slug,
        'PHASE18_ACCEPTED_SHA is absent; final Phase 19 acceptance cannot precede Phase 18',
      );
    }
  } finally {
    await chrome.kill();
  }

  const summary = {
    marker: 'MERIV2_PHASE19_BROWSER_ACCEPTANCE_SUMMARY',
    sha: SHA,
    baseUrl: BASE_URL,
    passed: results.filter((item) => item.status === 'passed').length,
    failed,
    blocked,
    result: failed > 0 ? 'failed' : blocked > 0 ? 'blocked' : 'passed',
    results,
  };
  await writeFile(
    path.join(EVIDENCE_DIR, 'results.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(summary));
  if (failed > 0) process.exitCode = 1;
  else if (blocked > 0) process.exitCode = 2;
}

main().catch(async (error) => {
  await mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => undefined);
  const payload = {
    marker: 'MERIV2_PHASE19_BROWSER_ACCEPTANCE_FATAL',
    sha: SHA,
    error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
  };
  await writeFile(
    path.join(EVIDENCE_DIR, 'fatal.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
