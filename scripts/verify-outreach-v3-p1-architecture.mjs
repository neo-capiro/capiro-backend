#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateOwnershipFixture } from './engagement-runtime-ownership.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PHASE1_BASE_SHA = process.env.OUTREACH_V3_P1_BASE_SHA || '46e029dad5c27bf44c7920cd5a4000716621671f';
export const REQUIRED_CAPABILITIES = [
  'search_capiro',
  'get_capiro_record',
  'get_client_context',
  'search_memory',
  'research_government',
  'analyze_relationships',
  'get_recent_activity',
  'search_targets',
  'get_target_profile',
].sort();

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}
function json(relative) {
  return JSON.parse(read(relative));
}
function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

export function validateCapabilityCatalog(catalog) {
  const problems = [];
  const names = catalog.map((entry) => entry.name);
  if (new Set(names).size !== names.length) problems.push('duplicate capability name');
  if (JSON.stringify([...names].sort()) !== JSON.stringify(REQUIRED_CAPABILITIES)) {
    problems.push('capability catalog names do not match the required closed set');
  }
  for (const name of names) {
    if (/^(meri|outreach)_/.test(name)) problems.push(`consumer-prefixed duplicate capability: ${name}`);
  }
  for (const required of ['get_client_context', 'get_recent_activity', 'get_capiro_record']) {
    if (catalog.find((entry) => entry.name === required)?.status !== 'implemented') {
      problems.push(`${required} must be implemented`);
    }
  }
  for (const entry of catalog) {
    for (const key of [
      'domainOwner',
      'inputSchema',
      'outputSchema',
      'authorizationLayer',
      'provenanceClass',
    ]) {
      if (!entry[key]) problems.push(`${entry.name} missing ${key}`);
    }
    if (entry.meriConsumer !== true || entry.outreachConsumer !== true) {
      problems.push(`${entry.name} must be shared by Meri and Outreach`);
    }
  }
  return problems;
}

export function validateReverseDependencies(entries) {
  const problems = [];
  const keys = new Set();
  for (const entry of entries) {
    const key = `${entry.consumerFile}:${entry.targetBoundary}`;
    if (keys.has(key)) problems.push(`duplicate reverse dependency ${key}`);
    keys.add(key);
    for (const field of [
      'consumerModule',
      'consumerFile',
      'currentImport',
      'symbols',
      'methodUses',
      'targetBoundary',
      'allowedAfterPhase1',
    ]) {
      if (!(field in entry)) problems.push(`${entry.consumerFile ?? 'entry'} missing ${field}`);
    }
    if (entry.allowedAfterPhase1 !== true) {
      problems.push(`${entry.consumerFile} still has a prohibited post-Phase-1 dependency`);
    }
  }
  return problems;
}

function providerImportProblem(source, file) {
  const importLines = source
    .split(/\r?\n/)
    .filter((line) => /^\s*import\b|\brequire\s*\(/.test(line))
    .join('\n')
    .toLowerCase();
  const forbidden = ['openai', '@modelcontextprotocol', 'langgraph', 'langchain'];
  return forbidden
    .filter((name) => importLines.includes(name))
    .map((name) => `${file} imports provider/reasoning runtime ${name}`);
}

export function architectureProblems() {
  const problems = [];
  const scopeEnd = process.env.OUTREACH_V3_P1_SCOPE_END;
  let catalog;
  if (scopeEnd) {
    const result = execFileSync('git', ['show', `${scopeEnd}:apps/api/src/capabilities/__fixtures__/capiro-capability-catalog.v1.json`], {
      cwd: ROOT, encoding: 'utf8',
    });
    catalog = JSON.parse(result);
  } else {
    catalog = json('apps/api/src/capabilities/__fixtures__/capiro-capability-catalog.v1.json');
  }
  problems.push(...validateCapabilityCatalog(catalog));

  const reverse = json(
    'apps/api/src/engagement/__fixtures__/outreach-v3-p1-reverse-dependencies.v1.json',
  );
  problems.push(...validateReverseDependencies(reverse));

  const ownership = json('infra/cdk/fixtures/engagement-runtime-ownership.v1.json');
  problems.push(...validateOwnershipFixture(ownership));

  const engagementModule = read('apps/api/src/engagement/engagement.module.ts');
  for (const forbidden of [
    'MicrosoftOAuthController',
    'GoogleOAuthController',
    'EngagementSyncSchedulerService',
  ]) {
    if (engagementModule.includes(forbidden)) {
      problems.push(`request/core EngagementModule still registers ${forbidden}`);
    }
  }
  for (const required of [
    'MeetingCapturePersistenceService',
    'OutreachJobService',
    'OutreachSendIntentService',
    'NotetakerService',
  ]) {
    if (!engagementModule.includes(required)) problems.push(`EngagementModule missing ${required}`);
  }
  if (!/new NotetakerService\(prisma, bot, persistence as never/.test(engagementModule)) {
    problems.push('Notetaker is not composed with the exact meeting-capture persistence port');
  }

  const reviewsModule = read('apps/api/src/reviews/reviews.module.ts');
  const reviewsService = read('apps/api/src/reviews/reviews.service.ts');
  for (const forbidden of ['EngagementModule', 'EngagementService', 'OutreachDraftService']) {
    if (reviewsModule.includes(forbidden) || reviewsService.includes(forbidden)) {
      problems.push(`Reviews still depends on broad ${forbidden}`);
    }
  }

  const alertMemoModule = read('apps/api/src/intelligence/alert-memo/alert-memo.module.ts');
  const districtBriefModule = read(
    'apps/api/src/intelligence/alert-memo/district-brief.module.ts',
  );
  const hearingRecapService = read(
    'apps/api/src/intelligence/alert-memo/hearing-recap.service.ts',
  );
  if (/^import\s+\{[^}]*EngagementModule/m.test(alertMemoModule)) {
    problems.push('AlertMemoModule still imports broad EngagementModule');
  }
  if (/^import\s+\{[^}]*EngagementModule/m.test(districtBriefModule)) {
    problems.push('DistrictBriefModule still imports broad EngagementModule');
  }
  if (hearingRecapService.includes('EngagementService')) {
    problems.push('HearingRecapService still imports broad EngagementService');
  }

  const meriModule = read('apps/api/src/meri/meri.module.ts');
  if (!meriModule.includes('AiCredentialsModule')) {
    problems.push('MeriModule does not consume the neutral AiCredentialsModule');
  }
  if (meriModule.includes("../engagement/ai-credential-resolver.service")) {
    problems.push('MeriModule still resolves credentials through the Engagement path');
  }

  const webhooksModule = read('apps/api/src/webhooks/webhooks.module.ts');
  if (webhooksModule.includes('EngagementModule') || webhooksModule.includes('RecallWebhook')) {
    problems.push('general WebhooksModule still owns Recall or imports Engagement');
  }

  const appModule = read('apps/api/src/app.module.ts');
  const engagementApiModule = read('apps/api/src/engagement-api.app.module.ts');
  for (const required of [
    'EngagementIntegrationActionsModule',
    'EngagementCallbacksModule',
    'EngagementWorkersModule',
    'RecallWebhookModule',
    'CapabilitiesModule',
  ]) {
    if (!appModule.includes(required) || !engagementApiModule.includes(required)) {
      problems.push(`${required} is not composed into both runtimes`);
    }
  }

  const capabilityFiles = [
    'apps/api/src/capabilities/capability-context.ts',
    'apps/api/src/capabilities/capability-result.ts',
    'apps/api/src/capabilities/capability-errors.ts',
    'apps/api/src/capabilities/capability-definition.ts',
    'apps/api/src/capabilities/capability-registry.ts',
    'apps/api/src/capabilities/adapters/capability-tool-adapter.ts',
  ];
  for (const file of capabilityFiles) problems.push(...providerImportProblem(read(file), file));

  const credentialController = read(
    'apps/api/src/ai-credentials/internal-ai-credentials.controller.ts',
  );
  if (!credentialController.includes('InternalServiceGuard')) {
    problems.push('raw AI credential controller is not protected by InternalServiceGuard');
  }

  for (const requiredFile of [
    'apps/api/src/engagement-workers/outreach-job-worker.service.ts',
    'apps/api/src/engagement-workers/outreach-send-intent-worker.service.ts',
    'apps/api/src/engagement-workers/notetaker-reconcile-worker.service.ts',
    'apps/api/src/engagement-callbacks/engagement-callbacks.module.ts',
    'apps/api/src/webhooks/recall-webhook.module.ts',
  ]) {
    if (!exists(requiredFile)) problems.push(`missing ${requiredFile}`);
  }

  const phase1ScopeEnd = process.env.OUTREACH_V3_P1_SCOPE_END ?? 'HEAD';
  let changed = [];
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${PHASE1_BASE_SHA}..${phase1ScopeEnd}`], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    problems.push('could not inspect Phase 1 changed-file scope');
  }
  for (const file of changed) {
    if (file.startsWith('apps/web/')) problems.push(`Phase 1 changed forbidden UI path ${file}`);
    if (file.includes('/prisma/migrations/')) problems.push(`Phase 1 added migration ${file}`);
    if (file.startsWith('infra/cdk/lib/')) problems.push(`Phase 1 changed AWS source ${file}`);
    if (/campaign[-_]spec|outreachsession|outreachevent/i.test(file)) {
      problems.push(`Phase 1 introduced later-phase state path ${file}`);
    }
  }

  for (const requiredDoc of [
    'docs/contracts/engagement-runtime-ownership-v1.md',
    'docs/contracts/capiro-capabilities-v1.md',
    'docs/runbooks/capiro-capability-security.md',
    'docs/runbooks/engagement-runtime-ownership.md',
    'docs/plans/outreach-v3/revised-phase-1-shared-foundations.md',
    'docs/plans/outreach-v3/revised-phase-2-readiness.md',
  ]) {
    if (!exists(requiredDoc)) problems.push(`missing required documentation ${requiredDoc}`);
  }

  return problems;
}

function main() {
  const problems = architectureProblems();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL  ${problem}`);
    console.error(`\nOUTREACH_V3_P1_ARCHITECTURE_INVALID (${problems.length})`);
    process.exit(1);
  }
  console.log('OUTREACH_V3_P1_ARCHITECTURE_VALID');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
