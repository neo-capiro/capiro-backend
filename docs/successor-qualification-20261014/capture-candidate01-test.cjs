const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const loader = require('./source-runtime-loader.cjs'); loader.install();
const cache = require('node:module').createRequire(loader.deps + '/apps/intel-api/package.json');
cache('reflect-metadata');
const { Test } = cache('@nestjs/testing'), { ConfigModule } = cache('@nestjs/config');
const read = (name) => require(path.join(loader.root, 'apps/intel-api/src', name));
const { PrismaModule } = read('prisma/prisma.module.ts');
const { PrismaService } = read('prisma/prisma.service.ts');
const { CaptureModule } = read('hearing/capture/capture.module.ts');
const { PublicCaptureCredentialsAdapter } = read('hearing/capture/public-capture-credentials.adapter.ts');
const { StreamResolverService } = read('hearing/stream-resolver.service.ts');
const { SourceDataRepository } = read('sourcedata/source-data.repository.ts');
const { FfmpegDeepgramCaptureRuntime } = read('hearing/capture/ffmpeg-deepgram-capture.runtime.ts');
const provider = Reflect.getMetadata('providers', CaptureModule).find((p) => p.provide === FfmpegDeepgramCaptureRuntime);
const input = () => ({ captureId: 'synthetic-capture', hearingId: 'synthetic-hearing',
  lease: { ownerId: 'synthetic-worker', fencingToken: 1 }, mediaUrl: 'https://synthetic.invalid/media',
  timelineOffsetMs: 0, signal: new AbortController().signal });
const credential = () => ({ apiKey: 'synthetic-platform-key', source: 'PLATFORM_SECRET',
  billingMode: 'PLATFORM_SHARED_PUBLIC_CAPTURE' });
test('actual CaptureModule Nest graph compiles without resolving optional capture credentials', async () => {
  let resolved = 0;
  const module = await Test.createTestingModule({ imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, CaptureModule,
  ] }).overrideProvider(PrismaService).useValue({ $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 })
    .overrideProvider(PublicCaptureCredentialsAdapter).useValue({ resolve: async () => { resolved++; throw new Error('Capture unavailable'); } })
    .compile();
  try {
    assert(module.get(StreamResolverService, { strict: false }) instanceof StreamResolverService);
    assert(module.get(SourceDataRepository, { strict: false }) instanceof SourceDataRepository);
    assert.equal(resolved, 0);
    assert.equal(typeof module.get(FfmpegDeepgramCaptureRuntime, { strict: false }).run, 'function');
  } finally { await module.close(); }
});
test('missing capture key fails the run without constructing or dispatching a capture', async () => {
  const error = new Error('Capture unavailable'); let calls = 0;
  const runtime = provider.useFactory({ resolve: async () => { calls++; throw error; } }, {}, {});
  assert.equal(calls, 0);
  await assert.rejects(runtime.run(input()), (e) => e === error); assert.equal(calls, 1);
});
test('concurrent runs keep separate credential/lease state and propagate exact results', async () => {
  const previous = FfmpegDeepgramCaptureRuntime.prototype.run; const seen = [], credentials = [];
  FfmpegDeepgramCaptureRuntime.prototype.run = async function (value) { seen.push([this, value]); return { capturedMs: value.timelineOffsetMs, gaps: [] }; };
  try {
    const runtime = provider.useFactory({ resolve: async (value) => { credentials.push(value); return credential(); } }, {}, {});
    const first = input(), second = { ...input(), captureId: 'synthetic-second', timelineOffsetMs: 42 };
    const results = await Promise.all([runtime.run(first), runtime.run(second)]);
    assert.deepEqual(results, [{ capturedMs: 0, gaps: [] }, { capturedMs: 42, gaps: [] }]);
    assert.deepEqual(credentials, [{ captureId: first.captureId, hearingId: first.hearingId }, { captureId: second.captureId, hearingId: second.hearingId }]);
    assert.notEqual(seen[0][0], seen[1][0]); assert.equal(seen[0][1], first); assert.equal(seen[1][1], second);
  } finally { FfmpegDeepgramCaptureRuntime.prototype.run = previous; }
});
test('credential failure is not cached across a fresh capture run', async () => {
  const previous = FfmpegDeepgramCaptureRuntime.prototype.run; let calls = 0;
  FfmpegDeepgramCaptureRuntime.prototype.run = async () => ({ capturedMs: 0, gaps: [] });
  try {
    const runtime = provider.useFactory({ resolve: async () => { if (++calls === 1) throw new Error('Missing'); return credential(); } }, {}, {});
    await assert.rejects(runtime.run(input()), /Missing/); assert.equal((await runtime.run(input())).capturedMs, 0); assert.equal(calls, 2);
  } finally { FfmpegDeepgramCaptureRuntime.prototype.run = previous; }
});
test('cancelled work does not resolve a credential or dispatch after the await', async () => {
  let resolved = 0; const controller = new AbortController(); controller.abort();
  const runtime = provider.useFactory({ resolve: async () => { resolved++; return credential(); } }, {}, {});
  await assert.rejects(runtime.run({ ...input(), signal: controller.signal })); assert.equal(resolved, 0);
  const during = new AbortController();
  const later = provider.useFactory({ resolve: async () => { during.abort(); return credential(); } }, {}, {});
  await assert.rejects(later.run({ ...input(), signal: during.signal }));
});
test('existing public-capture billing and identity invariants remain required', async () => {
  for (const change of [{ billingMode: 'TENANT_BYOK' }, { tenantId: 'synthetic-tenant' }, { apiKey: '' }]) {
    const runtime = provider.useFactory({ resolve: async () => ({ ...credential(), ...change }) }, {}, {});
    await assert.rejects(runtime.run(input()));
  }
});
test('exact source receipt and declared inert boundaries', (t) => {
  t.diagnostic(JSON.stringify({ ref: loader.ref, source: [...loader.consumed],
    scope: 'Real CaptureModule Nest DI compilation and exact factory invocation; Prisma/storage/provider/capture execution are mocked. No full app init, native engine, HTTP, credential/provider/DB/AWS operation.' }));
  loader.restore();
});
