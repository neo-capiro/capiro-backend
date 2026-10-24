import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ObjectiveNativeReader, readNativeObjectiveAcceptance } from './objective-native-reader.js';
import { readNativeObjectiveCompletion } from './objective-native-completion.js';

// Synthetic fixture captured from the paired Meri run-start, native SessionStore,
// completion and private reader owners. SQL and object I/O were synthetic ports;
// this is a closed wire/decoder control, not native DB or live-provider evidence.
const fixture = () => {
  const value = JSON.parse(readFileSync(resolve(__dirname, '../../test/fixtures/objective-native-wire.json'), 'utf8'));
  return { expected: value.expected, accepted: value.expected.acceptance,
    acceptance: value.initial, completion: value.completed, path: value.completed.file.path };
};
const refused = (run: () => unknown) => expect(run).toThrow('OUTCOME_UNCONFIRMED');
const endpoint = 'https://control.example.test';
const reader = (config: Record<string, string> = {}) => new ObjectiveNativeReader(new ConfigService({
  MERI_CONTROL_ORIGIN: endpoint, INTERNAL_SERVICE_SECRET: 'synthetic-test-secret', ...config,
}));
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

test('actual native envelope preserves exact accepted request and raw completed result', () => {
  const f = fixture(), accepted = readNativeObjectiveAcceptance(f.acceptance, f.expected);
  expect(accepted.sourceBinding).toEqual(f.acceptance.record.binding);
  const completed = readNativeObjectiveCompletion(f.completion, { ...f.expected, acceptance: f.accepted }, f.path);
  expect(completed.result).toEqual(JSON.parse(Buffer.from(f.completion.file.base64, 'base64').toString('utf8')));
  expect(completed.completionId).toBe(accepted.sourceBinding.runId);
});

test.each([
  ['principal', (v: any) => { v.record.binding.actorId = '00000000-0000-4000-8000-000000000099'; }],
  ['saved request', (v: any) => { v.request.prompt += 'changed'; }],
  ['selection', (v: any) => { v.record.selection.queuedType = 'other'; }],
  ['expiry', (v: any) => { v.record.effectExpiresAtMs++; }],
  ['scope', (v: any) => { v.run.scopes[0].resourceId = '00000000-0000-4000-8000-000000000099'; }],
  ['terminal refusal', (v: any) => { v.run.state = 'cancelled'; }],
])('native acceptance refuses altered %s', (_name, mutate) => {
  const f = fixture(); (mutate as (value: any) => void)(f.acceptance);
  refused(() => readNativeObjectiveAcceptance(f.acceptance, f.expected));
});

test.each([
  ['raw file', (v: any) => { v.file.base64 = Buffer.from('{}').toString('base64'); }],
  ['locator', (v: any) => { v.file.object.versionId += '-foreign'; }],
  ['session', (v: any) => { v.completion.sessionId = '00000000-0000-4000-8000-000000000099'; }],
  ['unpublished', (v: any) => { v.completion.state = 'UNKNOWN'; }],
  ['foreign scope', (v: any) => { v.completion.selectedClientId = '00000000-0000-4000-8000-000000000099'; }],
  ['versions', (v: any) => { v.completion.versions.promptVersion += '-changed'; }],
  ['binding', (v: any) => { v.completion.checkpointId = '00000000-0000-4000-8000-000000000099'; }],
  ['typed selection', (v: any) => { v.completion.typedSelection.strategy.request.input.goal = 'changed'; }],
])('native completion refuses altered %s', (_name, mutate) => {
  const f = fixture(); (mutate as (value: any) => void)(f.completion);
  refused(() => readNativeObjectiveCompletion(f.completion, { ...f.expected, acceptance: f.accepted }, f.path));
});

test('private HTTP uses one fixed source route, service authentication and no redirects', async () => {
  const f = fixture(), calls: any[] = [];
  global.fetch = jest.fn(async (url: any, options: any) => {
    calls.push([String(url), options]); return Response.json(f.acceptance);
  }) as typeof fetch;
  expect(await reader().acceptance(f.expected.admission.generationJobId, f.accepted.sourceAdmissionSha256)).toEqual(f.acceptance);
  expect(calls).toHaveLength(1); expect(calls[0][0]).toBe(endpoint + '/v1/internal/objective-generation/acceptance/read');
  expect(calls[0][1].redirect).toBe('error');
  expect(calls[0][1].headers).toEqual({ 'content-type': 'application/json', 'x-internal-service-secret': 'synthetic-test-secret' });
  expect(JSON.parse(calls[0][1].body)).toEqual({ schemaVersion: 1,
    generationJobId: f.expected.admission.generationJobId, sourceAdmissionSha256: f.accepted.sourceAdmissionSha256 });
});

test.each(['http://control.example.test', 'https://user:pass@control.example.test', 'https://control.example.test/path',
  'https://control.example.test/?query=1', 'https://control.example.test/#hash', 'not-an-origin'])('invalid origin refuses before I/O: %s', async origin => {
  global.fetch = jest.fn() as typeof fetch;
  await expect(reader({ MERI_CONTROL_ORIGIN: origin }).acceptance('job', 'hash')).rejects.toThrow('OUTCOME_UNCONFIRMED');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('missing secret and already-cancelled requests refuse before I/O', async () => {
  global.fetch = jest.fn() as typeof fetch;
  await expect(reader({ INTERNAL_SERVICE_SECRET: '' }).acceptance('job', 'hash')).rejects.toThrow('OUTCOME_UNCONFIRMED');
  await expect(reader().acceptance('job', 'hash', AbortSignal.abort())).rejects.toThrow('OUTCOME_UNCONFIRMED');
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  ['failure', () => new Response('{}', { status: 503 })],
  ['redirect', () => new Response('{}', { status: 302, headers: { location: 'https://elsewhere.test' } })],
  ['wrong type', () => new Response('{}')],
  ['invalid JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['invalid UTF8', () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })],
  ['declared overflow', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } })],
  ['actual overflow', () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })],
])('private HTTP refuses %s once and consumes/cancels its body', async (_name, make) => {
  const response = (make as () => Response)(); global.fetch = jest.fn(async () => response) as typeof fetch;
  await expect(reader().acceptance('job', 'hash')).rejects.toThrow('OUTCOME_UNCONFIRMED');
  expect(global.fetch).toHaveBeenCalledTimes(1); expect(response.body?.locked).toBe(false);
});

test('caller cancellation stops an in-flight private read without retry', async () => {
  const controller = new AbortController();
  global.fetch = jest.fn((_url: any, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true });
    controller.abort();
  })) as typeof fetch;
  await expect(reader().acceptance('job', 'hash', controller.signal)).rejects.toThrow('OUTCOME_UNCONFIRMED');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
