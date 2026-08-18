/** Bounded Outreach V3 capability switches for the dark engagement-api task. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import { engagementApiTaskEnvironment } from '../lib/engagement-api/engagement-api-service-stack';

const FIXTURE = path.resolve(__dirname, '../fixtures/engagement-api.test.json');

test('Outreach V3 is explicitly enabled without opening the global shadow controls', () => {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  const env = engagementApiTaskEnvironment(cfg);

  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'shadow');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'disabled');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  assert.equal(env.ENGAGEMENT_CALLBACKS_ENABLED, 'false');

  for (const key of [
    'OUTREACH_V3_STATE_ENABLED',
    'OUTREACH_V3_REASONING_ENABLED',
    'OUTREACH_V3_TARGETS_ENABLED',
    'OUTREACH_V3_CONTEXT_ENABLED',
    'OUTREACH_V3_GENERATION_ENABLED',
    'OUTREACH_V3_DRAFTS_ENABLED',
    'OUTREACH_V3_SEND_ENABLED',
    'OUTREACH_V3_FULL_GENERATION_ENABLED',
    'ENGAGEMENT_GENERATION_GATEWAY',
    'ENGAGEMENT_VERSIONED_OUTREACH',
  ]) {
    assert.equal(env[key], 'true', `${key} must be explicitly enabled`);
  }

  // Reasoning depth is asserted, not merely present: a stack update that dropped
  // it would silently fall back to the code default, and "which depth did this
  // campaign draft at" would stop being answerable from the task definition.
  assert.equal(env.OUTREACH_V3_GENERATION_EFFORT, 'max');

  // The effort above is inert unless the model accepts a reasoning parameter, so
  // the pair is asserted together — dropping either one silently returns V3
  // drafting to no reasoning at all, which is the failure this pins.
  assert.equal(env.OUTREACH_V3_GENERATION_MODEL, 'gpt-5');
});
