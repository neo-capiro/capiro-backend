import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let canonicalCore;
function receiptCore() {
  // The ordinary collector and closed LIVE guards do not need built core output.
  // Only signed diagnostics load the actual verifier; no local substitute exists.
  try {
    return (canonicalCore ??= require('../../../packages/meriv2-core/dist/context/capture-evidence-receipt.js'));
  } catch {
    reject('CAPTURE_RECEIPT_CANONICAL_VERIFIER_UNAVAILABLE');
  }
}

const NUMERIC_USAGE = new Set([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'estimatedCostUsd',
]);
const SECRET_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key|session)/iu;
const CREDENTIAL =
  /Bearer\s+[^\s,;"']+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?:[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY))\s*[=:]\s*[^\s,;"']+|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+|\bsk-[A-Za-z0-9_-]{16,}/iu;
export const MISSING_CAPTURE_OWNERS = Object.freeze([
  'CURRENT_AUTHORIZATION_OWNER_UNBOUND',
  'FIXTURE_IDENTITY_AND_RECEIPT_OWNER_UNBOUND',
  'APPROVED_IMMUTABLE_BUILD_OWNER_UNBOUND',
  'RAW_SOURCE_TOOL_EFFECT_USAGE_CROSSCHECK_UNBOUND',
]);

export class ControlledReceiptError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const reject = (code) => {
  throw new ControlledReceiptError(code);
};
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function observation(value, type) {
  if (!plain(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['reason', 'status', 'value']))
    reject('CAPTURE_RECEIPT_USAGE_MALFORMED');
  if (value.status === 'OBSERVED') {
    if (
      typeof value.value !== type ||
      value.reason !== null ||
      (type === 'number' && (!Number.isFinite(value.value) || value.value < 0))
    )
      reject('CAPTURE_RECEIPT_USAGE_MALFORMED');
  } else if (
    !['UNKNOWN', 'NOT_RUN', 'PENDING_BINDING'].includes(value.status) ||
    value.value !== null ||
    typeof value.reason !== 'string' ||
    !value.reason.trim()
  )
    reject('CAPTURE_RECEIPT_USAGE_MALFORMED');
}

function usageSchema(usage) {
  const keys = [...NUMERIC_USAGE, 'provider', 'model', 'costKind'].sort();
  if (!plain(usage) || !isDeepStrictEqual(Object.keys(usage).sort(), keys))
    reject('CAPTURE_RECEIPT_USAGE_MALFORMED');
  for (const key of NUMERIC_USAGE) observation(usage[key], 'number');
  for (const key of ['provider', 'model']) observation(usage[key], 'string');
  if (!['existing_pricing_estimate', 'unknown'].includes(usage.costKind))
    reject('CAPTURE_RECEIPT_USAGE_MALFORMED');
}

// Exact path exceptions apply only to already validated numeric observations.
// Everything else retains the generic collector's secret-key boundary.
function assertPrivateJson(value, known, path = [], ancestors = new Set()) {
  const secretText = (text) =>
    CREDENTIAL.test(text) || known.some((secret) => text.includes(secret));
  if (typeof value === 'string') {
    if (secretText(value)) reject('CAPTURE_RECEIPT_SECRET_DETECTED');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('CAPTURE_RECEIPT_NON_JSON');
    return;
  }
  if (typeof value !== 'object' || ancestors.has(value) || path.length > 64)
    reject('CAPTURE_RECEIPT_NON_JSON');
  if (!Array.isArray(value) && !plain(value)) reject('CAPTURE_RECEIPT_NON_JSON');
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) {
    const numericSlot =
      path.length === 2 && path[0] === 'receipt' && path[1] === 'usage' && NUMERIC_USAGE.has(key);
    if (secretText(key) || (!numericSlot && SECRET_KEY.test(key)))
      reject('CAPTURE_RECEIPT_SECRET_DETECTED');
    assertPrivateJson(item, known, [...path, key], ancestors);
  }
  ancestors.delete(value);
}

function fixturePolicyBinding(receipt, policy) {
  if (!plain(receipt.fixture) || receipt.fixture.namespace !== policy.fixtureNamespace)
    reject('CAPTURE_RECEIPT_FIXTURE_POLICY_MISMATCH');
  for (const [key, policyKey] of [
    ['version', 'fixtureVersion'],
    ['physicalMapSha256', 'physicalMapSha256'],
    ['resetReceiptId', 'resetReceiptId'],
    ['seedReceiptId', 'seedReceiptId'],
  ]) {
    const value = receipt.fixture[key];
    observation(value, 'string');
    if (policy[policyKey] === null) {
      if (value.status === 'OBSERVED' || value.value !== null)
        reject('CAPTURE_RECEIPT_FIXTURE_POLICY_MISMATCH');
    } else if (
      typeof policy[policyKey] !== 'string' ||
      value.status !== 'OBSERVED' ||
      value.value !== policy[policyKey]
    )
      reject('CAPTURE_RECEIPT_FIXTURE_POLICY_MISMATCH');
  }
}

/** Trusted policy and secret are independent in-memory inputs; never obtained from config/envelope. */
export function inspectControlledCaptureReceiptPair({
  provenance,
  frameEnvelope,
  metadataEnvelope,
  trustedPolicy,
  serviceSecret,
  secretValues = [],
  now = Date.now(),
}) {
  if (provenance !== 'UNIT_FIXTURE_NOT_LIVE') reject('CONTROLLED_RECEIPT_ONLY');
  if (!plain(frameEnvelope)) reject('CAPTURE_RECEIPT_FRAME_MISSING');
  if (!plain(metadataEnvelope)) reject('CAPTURE_RECEIPT_METADATA_MISSING');
  if (!isDeepStrictEqual(frameEnvelope, metadataEnvelope)) reject('CAPTURE_RECEIPT_PAIR_MISMATCH');
  if (!plain(trustedPolicy)) reject('CAPTURE_RECEIPT_INDEPENDENT_POLICY_MISSING');
  if (typeof serviceSecret !== 'string' || !serviceSecret.trim())
    reject('CAPTURE_RECEIPT_SERVICE_IDENTITY_MISSING');
  usageSchema(frameEnvelope.receipt?.usage);
  const known = [...secretValues, serviceSecret, serviceSecret.trim()].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  assertPrivateJson(frameEnvelope, known);
  const { verifyMeriCaptureEvidenceReceipt, meriCaptureEvidenceEnvelopeSha256 } = receiptCore();
  let receipt;
  try {
    receipt = verifyMeriCaptureEvidenceReceipt(frameEnvelope, trustedPolicy, serviceSecret, now);
  } catch {
    reject('CAPTURE_RECEIPT_AUTHENTICATION_FAILED');
  }
  fixturePolicyBinding(receipt, trustedPolicy);
  return {
    status: 'NOT_RUN',
    reason: 'CONTROLLED_SIGNATURE_CHECK_IS_NOT_ACCEPTANCE',
    signatureCheck: 'VALID_FOR_INDEPENDENTLY_SUPPLIED_POLICY',
    envelopeSha256: meriCaptureEvidenceEnvelopeSha256(frameEnvelope),
    producerStatus: receipt.status,
    producerBlockers: [...receipt.blockers],
    missingOwners: [...MISSING_CAPTURE_OWNERS],
  };
}

/** Does not redact signed data. Refuses unsafe data before the first artifact write. */
export async function writeControlledCaptureReceipt({ collector, ref, ...input }) {
  if (
    collector.owner?.provenance !== 'UNIT_FIXTURE_NOT_LIVE' ||
    input.provenance !== 'UNIT_FIXTURE_NOT_LIVE'
  )
    reject('CONTROLLED_RECEIPT_ONLY');
  const inspection = inspectControlledCaptureReceiptPair({
    ...input,
    provenance: collector.owner.provenance,
    secretValues: [...collector.secretValues, ...(input.secretValues ?? [])],
  });
  const bytes = Buffer.from(`${JSON.stringify(input.frameEnvelope, null, 2)}\n`, 'utf8');
  // Canonical JSON verification catches values that cannot survive JSON serialization.
  const serialized = JSON.parse(bytes.toString('utf8'));
  if (!isDeepStrictEqual(serialized, input.frameEnvelope)) reject('CAPTURE_RECEIPT_NON_JSON');
  const descriptor = await collector.writeBytes(ref, bytes);
  const readback = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await collector.readBytes(ref)),
  );
  if (!isDeepStrictEqual(readback, serialized)) reject('CAPTURE_RECEIPT_ARTIFACT_MISMATCH');
  const verified = inspectControlledCaptureReceiptPair({
    ...input,
    provenance: collector.owner.provenance,
    frameEnvelope: readback,
    metadataEnvelope: serialized,
    secretValues: [...collector.secretValues, ...(input.secretValues ?? [])],
  });
  if (verified.envelopeSha256 !== inspection.envelopeSha256)
    reject('CAPTURE_RECEIPT_ARTIFACT_MISMATCH');
  return { ...inspection, artifact: descriptor };
}
