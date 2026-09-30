import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  ArtifactCollector,
  redactSecrets,
  verifyCollectedArtifacts,
} from '../artifact-collector.mjs';
import {
  inspectControlledCaptureReceiptPair,
  writeControlledCaptureReceipt,
} from '../controlled-capture-receipt.mjs';
import {
  verifyMeriCaptureEvidenceReceipt,
  meriCaptureEvidenceEnvelopeSha256,
  completeMeriCaptureEvidenceReceipt,
} from '../../../../packages/meriv2-core/dist/context/capture-evidence-receipt.js';
import { context, receipt, signed, NOW, SECRET } from './controlled-capture-receipt-fixtures.mjs';

function input(overrides = {}) {
  const envelope = signed();
  return {
    provenance: 'UNIT_FIXTURE_NOT_LIVE',
    frameEnvelope: envelope,
    metadataEnvelope: structuredClone(envelope),
    ...context(),
    ...overrides,
  };
}
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  return value;
}
async function owned(callback) {
  const parent = resolve(process.platform === 'win32' ? 'C:/dev' : tmpdir());
  const scratch = await mkdtemp(join(parent, 'cap-meri-receipt-test-'));
  const root = join(scratch, 'run');
  try {
    const collector = new ArtifactCollector(
      root,
      { provenance: 'UNIT_FIXTURE_NOT_LIVE', captureRunId: 'controlled-run' },
      ['known-sensitive-value'],
    );
    await collector.init();
    return await callback(collector, root);
  } finally {
    assert.equal(dirname(scratch), parent);
    assert.ok(scratch.startsWith(join(parent, 'cap-meri-receipt-test-')));
    await rm(scratch, { recursive: true, force: true });
  }
}

test('actual controlled artifact roundtrip preserves signed usage and unknowns; generic redaction remains unchanged', () =>
  owned(async (collector, root) => {
    const value = input();
    const result = await writeControlledCaptureReceipt({
      collector,
      ref: 'receipt.json',
      ...value,
    });
    const stored = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'));
    assert.deepEqual(stored, value.frameEnvelope);
    assert.equal(
      verifyMeriCaptureEvidenceReceipt(stored, value.trustedPolicy, SECRET, NOW).usage.inputTokens
        .value,
      120,
    );
    assert.equal(meriCaptureEvidenceEnvelopeSha256(stored), result.envelopeSha256);
    assert.deepEqual(stored.receipt.usage.cacheReadTokens, {
      status: 'UNKNOWN',
      value: null,
      reason: 'not_reported',
    });
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.missingOwners.length, 4);
    assert.equal(redactSecrets(value.frameEnvelope).receipt.usage.inputTokens, '[REDACTED]');
    await collector.finalize({ status: 'NOT_RUN' });
    assert.equal((await verifyCollectedArtifacts(root)).valid, true);
  }));

test('JSONB object key reordering preserves pair and canonical digest', () => {
  const value = input();
  value.metadataEnvelope = reverseKeys(value.frameEnvelope);
  assert.equal(
    inspectControlledCaptureReceiptPair(value).envelopeSha256,
    meriCaptureEvidenceEnvelopeSha256(value.frameEnvelope),
  );
});
for (const [name, mutate, code] of [
  [
    'missing frame',
    (v) => {
      delete v.frameEnvelope;
    },
    'FRAME_MISSING',
  ],
  [
    'missing metadata',
    (v) => {
      delete v.metadataEnvelope;
    },
    'METADATA_MISSING',
  ],
  [
    'missing independent policy',
    (v) => {
      delete v.trustedPolicy;
    },
    'INDEPENDENT_POLICY_MISSING',
  ],
  [
    'missing service identity',
    (v) => {
      delete v.serviceSecret;
    },
    'SERVICE_IDENTITY_MISSING',
  ],
  [
    'wrong policy tuple',
    (v) => {
      v.trustedPolicy.tenantId = 'foreign';
    },
    'AUTHENTICATION_FAILED',
  ],
  [
    'expired receipt',
    (v) => {
      v.now = NOW + 120000;
    },
    'AUTHENTICATION_FAILED',
  ],
  [
    'metadata changed',
    (v) => {
      v.metadataEnvelope.receipt.usage.inputTokens.value += 1;
    },
    'PAIR_MISMATCH',
  ],
  [
    'signature tamper in both copies',
    (v) => {
      v.frameEnvelope.signature = 'f'.repeat(64);
      v.metadataEnvelope.signature = v.frameEnvelope.signature;
    },
    'AUTHENTICATION_FAILED',
  ],
  [
    'LIVE guarded',
    (v) => {
      v.provenance = 'LIVE_CAPTURE';
    },
    'CONTROLLED_RECEIPT_ONLY',
  ],
])
  test(name + ' writes no signed receipt', () =>
    owned(async (collector, root) => {
      const value = input();
      mutate(value);
      await assert.rejects(
        writeControlledCaptureReceipt({ collector, ref: 'receipt.json', ...value }),
        new RegExp(code),
      );
      assert.equal((await readdir(root)).includes('receipt.json'), false);
    }),
  );

test('array order is exact even when all values exist', () => {
  const r = receipt();
  r.toolCalls.push({ ...r.toolCalls[0], callId: 'call-2', sourceIds: [] });
  const envelope = signed(r);
  const value = input({ frameEnvelope: envelope, metadataEnvelope: structuredClone(envelope) });
  value.metadataEnvelope.receipt.toolCalls.reverse();
  assert.throws(() => inspectControlledCaptureReceiptPair(value), /PAIR_MISMATCH/);
});
for (const field of [
  'namespace',
  'version',
  'physicalMapSha256',
  'resetReceiptId',
  'seedReceiptId',
])
  test('signed wrong fixture ' + field + ' rejected against independent policy', () => {
    const r = receipt();
    if (field === 'namespace') r.fixture[field] = 'foreign';
    else r.fixture[field].value = 'foreign';
    const envelope = signed(r);
    assert.throws(
      () =>
        inspectControlledCaptureReceiptPair(
          input({ frameEnvelope: envelope, metadataEnvelope: structuredClone(envelope) }),
        ),
      /FIXTURE_POLICY_MISMATCH/,
    );
  });
for (const [name, mutate] of [
  [
    'known nested secret',
    (r) => {
      r.sources[0].locator.value = 'known-sensitive-value';
    },
  ],
  [
    'known secret key',
    (r) => {
      r['known-sensitive-value'] = 'value';
    },
  ],
  [
    'service secret',
    (r) => {
      r.sources[0].locator.value = SECRET;
    },
  ],
  [
    'Bearer text',
    (r) => {
      r.sources[0].locator.value = 'Bearer abc123';
    },
  ],
  [
    'JWT text',
    (r) => {
      r.sources[0].locator.value = 'eyJfixturetoken123456.abcdefgh12345678.signature12345678';
    },
  ],
  [
    'credential assignment',
    (r) => {
      r.sources[0].locator.value = 'INTERNAL_SERVICE_SECRET=abc123';
    },
  ],
  [
    'arbitrary token key',
    (r) => {
      r.extraToken = 3;
    },
  ],
  [
    'misplaced numeric observation',
    (r) => {
      r.inputTokens = { status: 'OBSERVED', value: 3, reason: null };
    },
  ],
  [
    'extra field inside numeric observation',
    (r) => {
      r.usage.inputTokens.password = 'value';
    },
  ],
])
  test(name + ' is rejected without mutating signed data or writing', () =>
    owned(async (collector, root) => {
      const r = receipt();
      mutate(r);
      const envelope = signed(r);
      const before = JSON.stringify(envelope);
      await assert.rejects(
        writeControlledCaptureReceipt({
          collector,
          ref: 'receipt.json',
          ...input({ frameEnvelope: envelope, metadataEnvelope: structuredClone(envelope) }),
        }),
        /SECRET_DETECTED|USAGE_MALFORMED/,
      );
      assert.equal(JSON.stringify(envelope), before);
      assert.equal((await readdir(root)).includes('receipt.json'), false);
    }),
  );
for (const invalid of [-1, Infinity, NaN, '120', null])
  test('invalid numeric usage ' + String(invalid), () => {
    const r = receipt();
    r.usage.inputTokens.value = invalid;
    const envelope = signed(r);
    assert.throws(
      () =>
        inspectControlledCaptureReceiptPair(
          input({ frameEnvelope: envelope, metadataEnvelope: structuredClone(envelope) }),
        ),
      /USAGE_MALFORMED/,
    );
  });
for (const status of ['UNKNOWN', 'NOT_RUN', 'PENDING_BINDING'])
  test('numeric unknown state stays explicit: ' + status, () => {
    const r = receipt();
    r.usage.inputTokens = { status, value: null, reason: 'owner_unavailable' };
    const envelope = signed(completeMeriCaptureEvidenceReceipt(r));
    const result = inspectControlledCaptureReceiptPair(
      input({ frameEnvelope: envelope, metadataEnvelope: structuredClone(envelope) }),
    );
    assert.equal(result.producerStatus, 'BLOCKED');
    assert.equal(result.status, 'NOT_RUN');
  });

test('artifact readback tamper detected after actual disk write', () =>
  owned(async (collector) => {
    const read = collector.readBytes.bind(collector);
    collector.readBytes = async (ref) => {
      const value = JSON.parse((await read(ref)).toString('utf8'));
      value.receipt.usage.inputTokens.value++;
      return Buffer.from(JSON.stringify(value));
    };
    await assert.rejects(
      writeControlledCaptureReceipt({ collector, ref: 'receipt.json', ...input() }),
      /ARTIFACT_MISMATCH/,
    );
  }));
