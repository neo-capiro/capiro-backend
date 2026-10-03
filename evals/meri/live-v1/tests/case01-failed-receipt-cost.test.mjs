import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASE01_FAILED_RECEIPT_COST_PINS as pins } from '../case01-failed-receipt-cost-pins.mjs';
import { inspectCase01FailedReceiptCost as inspect,
  consumeCase01FailedReceiptCostAuthority as consume } from '../case01-failed-receipt-cost-authority.mjs';
import { reconcileCase01FailedReceiptCost as reconcile } from '../capture-spend-aggregate.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const input = JSON.parse(readFileSync(new URL('./fixtures/case01-failed-receipt-cost.unit.json', import.meta.url)));
test('exact failed capture produces cost-only proof; no accepted envelope is invented', () => {
  const proof = inspect(structuredClone(input));
  assert.equal(sha256Stable(proof), '59b7055d48bb074d13f57eb16c93334b258800107c039667aa445c3bf5e26648');
  assert.equal(proof.chargedCostMicros, 2292602);
  assert.equal(proof.captureAuthority, false);
  assert.equal(proof.captureStatus, 'CAPTURE_UNCERTAIN');
  assert.equal(proof.answerGrade, 'NOT_EVALUATED');
  assert.equal('envelopeSha256' in proof, false);
});
const changes = [
  x => x.execution.outcome.synthesisSubmissionCount++,
  x => x.execution.sessionRevoked = false,
  x => x.execution.newReservationAttempted = true,
  x => x.execution.orchestratorSha = '0'.repeat(40),
  x => x.stream.captureAuthority = true,
  x => x.stream.text = x.stream.text.replace('meri_capture_receipt_readback_mismatch', 'other'),
  x => x.database.acceptanceAuthority = true,
  x => x.database.readOnlyTransaction = false,
  x => x.databaseCleanup.cleanupComplete = false,
  x => x.database.ormMessages.pop(),
  x => x.database.ormMessages[0].body = 'different prompt',
  x => x.database.ormMessages[1].clientId = x.database.userId,
  x => x.database.rawMessages[1].metadata_text = '{}',
  x => x.postdeadline.sessionRevoked = false,
  x => x.postdeadline.afterProviderDeadline = false,
  x => x.postdeadline.journalUnchanged = false,
  x => x.postdeadlineMe.value.role = 'firm_admin',
  x => x.postdeadline.reads[1].apiReleaseSha = '0'.repeat(40),
  x => x.postdeadlineConversation.value.metadata.serverCaptureProviderBudget.ledger.attempts.pop(),
  x => x.postdeadline.conversation.metadata.serverCaptureProviderBudget.ledger.attempts[0].status = 'uncertain',
  x => x.postdeadline.conversation.metadata.serverCaptureProviderBudget.ledger.chargedCostMicros = 0,
  x => x.checkpoint.snapshot.eventCount = 22,
  x => x.checkpoint.snapshot.activeRun = null,
];
for (const [index, change] of changes.entries()) test(`mismatched evidence ${index + 1} cannot release the ceiling`, () => {
  const value = structuredClone(input); change(value); assert.throws(() => inspect(value), /COST_REJECTED/);
});
test('forged opaque authority and wrong invocation cannot reach the native writer', () => {
  const fake = { kind: 'case01-failed-receipt-terminal-cost' };
  assert.throws(() => consume(fake));
  assert.throws(() => reconcile(fake, { pythonExecutable: 'wrong', invocation: 'RECONCILE_FAILED_CASE01_PROVIDER_COST_ONCE' }));
  assert.throws(() => reconcile(fake, { pythonExecutable: 'wrong', invocation: 'anything' }));
});
test('isolated filesystem pins and one-use capability reject tampering without live access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'meri-cost-authority-'));
  const copiedPins = {};
  for (const name of Object.keys(pins)) {
    const bytes = name === 'journal'
      ? readFileSync(new URL('./fixtures/case01-failed-receipt-journal21.unit.jsonl', import.meta.url))
      : Buffer.from(JSON.stringify(input[name] ?? {}, null, name === 'database' ? 0 : 2) + '\n');
    copiedPins[name] = { path: join(root, name + '.fixture'), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(copiedPins[name].path, bytes);
  }
  assert.equal(copiedPins.database.sha256, pins.database.sha256);
  const pinPath = join(root, 'test-pins.mjs');
  writeFileSync(pinPath, 'export const CASE01_FAILED_RECEIPT_COST_PINS = ' + JSON.stringify(copiedPins) + ';');
  const sourceUrl = new URL('../case01-failed-receipt-cost-authority.mjs', import.meta.url);
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/from '(\.\/[^']+)'/gu, (_all, ref) => `from '${new URL(ref, sourceUrl).href}'`)
    .replace(new URL('../case01-failed-receipt-cost-pins.mjs', import.meta.url).href, pathToFileURL(pinPath).href);
  const modulePath = join(root, 'test-authority.mjs'); writeFileSync(modulePath, source);
  const isolated = await import(pathToFileURL(modulePath).href);
  const authority = isolated.prepareCase01FailedReceiptCostAuthority();
  assert.equal(isolated.consumeCase01FailedReceiptCostAuthority(authority).proof.chargedCostMicros, 2292602);
  assert.throws(() => isolated.consumeCase01FailedReceiptCostAuthority(authority));
  const poisoned = isolated.prepareCase01FailedReceiptCostAuthority();
  writeFileSync(copiedPins.journal.path, '{}\n');
  assert.throws(() => isolated.consumeCase01FailedReceiptCostAuthority(poisoned));
  assert.throws(() => isolated.prepareCase01FailedReceiptCostAuthority());
});
