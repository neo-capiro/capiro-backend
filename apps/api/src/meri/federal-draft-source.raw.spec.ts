import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFederalDraftSource } from './federal-draft-source.js';
const vector = JSON.parse(readFileSync(join(__dirname, 'federal-raw-source.wire.json'), 'utf8'));
const legacy = JSON.parse(readFileSync(join(__dirname, 'federal-draft-source.wire.json'), 'utf8'));
const row = () => ({
  ...vector.response.source,
  rawContent: vector.response.raw.text,
  capture: vector.response.raw.capture,
});
const call = (value: unknown, request = vector.request) =>
  readFederalDraftSource(
    { $queryRaw: jest.fn(async () => (value === null ? [] : [value])) } as never,
    request,
  );
test('canonical raw serializer matches the cross-repository fixture exactly', async () => {
  expect(JSON.parse(JSON.stringify(await call(row())))).toEqual(vector.response);
});
test('old unnegotiated wire remains byte-shape exact even when metadata is queried', async () => {
  const oldRow = {
    ...legacy.response.source,
    rawContent: '<text>' + legacy.response.source.text + '</text>',
    capture: null,
  };
  expect(JSON.parse(JSON.stringify(await call(oldRow, legacy.request)))).toEqual(legacy.response);
});
test.each([
  [{ capture: null }, 'raw_capture_unreported'],
  [{ capture: { ...vector.response.raw.capture, byteLength: 1 } }, 'raw_capture_unverified'],
  [
    { capture: { ...vector.response.raw.capture, sha256: '0'.repeat(64) } },
    'raw_capture_unverified',
  ],
  [{ capture: { ...vector.response.raw.capture, format: 'htm' } }, 'raw_capture_unsupported'],
  [{ evidenceParserVersion: 'federal-legislative-exact-code-v1' }, 'raw_capture_unsupported'],
  [{ rawContent: vector.response.raw.text + 'changed' }, 'source_integrity_unverified'],
])('qualified mode refuses missing, invalid or unsupported custody', async (patch, reason) => {
  expect(await call({ ...row(), ...patch })).toMatchObject({
    currentStatus: 'unavailable',
    representation: 'retained-raw-utf8/1',
    reason,
  });
});
test('suppressed/current-missing selection never falls back, and unknown negotiation refuses before SQL', async () => {
  expect(await call(null)).toMatchObject({ reason: 'exact_current_source_unavailable' });
  const query = jest.fn();
  await expect(
    readFederalDraftSource({ $queryRaw: query } as never, {
      ...vector.request,
      representation: 'raw-anything',
    }),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
