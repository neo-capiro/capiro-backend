import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, sendToTesterGate } from './checks.mjs';
import { TEST_ACCOUNT } from './auth.mjs';

const card = (overrides = {}) => ({
  proposalId: 'proposal-1',
  tool: 'send_email',
  status: 'proposed',
  preview: { fields: { to: TEST_ACCOUNT, subject: 'Today' } },
  ...overrides,
});

test('T8 gate approves only one proposed card addressed to the tester alone', () => {
  assert.deepEqual(sendToTesterGate([card()], TEST_ACCOUNT), { ok: true, proposal: card() });
  assert.equal(
    sendToTesterGate([card({ preview: { fields: { to: TEST_ACCOUNT.toUpperCase() } } })], TEST_ACCOUNT).ok,
    true,
  );
});

test('T8 gate refuses any other recipient, cc, bcc, or more than one card', () => {
  const reason = (rows) => sendToTesterGate(rows, TEST_ACCOUNT).reason;
  assert.equal(reason([card({ preview: { fields: { to: 'someone@example.com' } } })]), 'SEND_RECIPIENT_NOT_TESTER');
  assert.equal(
    reason([card({ preview: { fields: { to: `${TEST_ACCOUNT}, someone@example.com` } } })]),
    'SEND_RECIPIENT_NOT_TESTER',
  );
  assert.equal(reason([card({ preview: { fields: { to: TEST_ACCOUNT, cc: 'x@example.com' } } })]), 'SEND_HAS_CC_OR_BCC');
  assert.equal(reason([card({ preview: { fields: { to: TEST_ACCOUNT, bcc: 'x@example.com' } } })]), 'SEND_HAS_CC_OR_BCC');
  assert.equal(reason([card(), card({ proposalId: 'proposal-2' })]), 'SEND_PROPOSAL_MATCH_2_OF_2');
  assert.equal(reason([]), 'SEND_PROPOSAL_MATCH_0_OF_0');
  assert.equal(reason([card({ tool: 'create_task' })]), 'SEND_PROPOSAL_MATCH_0_OF_1');
});

test('T8 gate fails if anything was sent before approval', () => {
  for (const status of ['succeeded', 'executing', 'outcome_unknown'])
    assert.equal(sendToTesterGate([card({ status })], TEST_ACCOUNT).reason, 'SENT_BEFORE_APPROVAL');
});

const run = (proposals) => ({
  proposals,
  turns: [
    {
      prompt: 'p',
      answer: 'a',
      client: 'L3 Harris',
      httpStatus: 200,
      done: { partial: false },
      citations: [{}],
    },
  ],
});

test('an audit proposes nothing; a send proposes exactly one send_email', () => {
  const operation = (op, proposals) =>
    runChecks({ op, citations: false }, run(proposals), null, []).checks.find((x) => x.id === 'operation').status;
  assert.equal(operation('audit', []), 'pass');
  assert.equal(operation('audit', [{ tool: 'create_task', status: 'proposed' }]), 'fail');
  assert.equal(operation('send', [{ tool: 'send_email', status: 'succeeded' }]), 'pass');
  assert.equal(operation('send', [{ tool: 'create_task', status: 'succeeded' }]), 'fail');
});
