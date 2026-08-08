import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadOwnershipFixture,
  validateOwnershipFixture,
} from './engagement-runtime-ownership.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepted current and future ownership profiles are valid', () => {
  assert.deepEqual(validateOwnershipFixture(loadOwnershipFixture()), []);
});

test('dual worker owner fails', () => {
  const fixture = clone(loadOwnershipFixture());
  fixture.currentProductionProfile.services['engagement-api'].backgroundOwner = 'engagement-api';
  assert.match(validateOwnershipFixture(fixture).join('\n'), /exactly one owner/);
});

test('dual callback owner fails', () => {
  const fixture = clone(loadOwnershipFixture());
  fixture.currentProductionProfile.services['engagement-api'].callbacksEnabled = true;
  assert.match(validateOwnershipFixture(fixture).join('\n'), /callbacks.*exactly one owner/);
});

test('dual Recall owner fails', () => {
  const fixture = clone(loadOwnershipFixture());
  fixture.currentProductionProfile.services['engagement-api'].recallWebhookEnabled = true;
  assert.match(validateOwnershipFixture(fixture).join('\n'), /recall.*exactly one owner/);
});

test('future profile cannot be made production-allowed', () => {
  const fixture = clone(loadOwnershipFixture());
  fixture.futureRehearsalProfile.productionAllowed = true;
  assert.match(validateOwnershipFixture(fixture).join('\n'), /test-only/);
});
