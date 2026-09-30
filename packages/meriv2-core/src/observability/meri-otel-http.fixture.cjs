const { createServer } = require('node:http');
const { createMeriOtelRuntime } = require('./meri-otel.ts');
const { createMeriTelemetryContext, meriTelemetryUsage } = require('./meri-joined-telemetry.ts');
(async () => {
  const bodies = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      bodies.push({
        path: req.url,
        contentType: req.headers['content-type'],
        body: JSON.parse(data),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = createMeriOtelRuntime({
    serviceName: 'capiro-api',
    release: 'a'.repeat(40),
    tracesEndpoint: `http://127.0.0.1:${server.address().port}/v1/traces`,
  });
  const root = createMeriTelemetryContext({ tenantId: 'tenant-a', actorId: 'actor-a' });
  try {
    if (!runtime.isEnabled()) throw new Error('local exporter failed to initialize');
    await runtime.withSpan(
      root,
      { name: 'meri.request', boundary: 'browser_api' },
      async (parent) => {
        await runtime.withSpan(
          parent,
          { name: 'meri.provider.attempt', boundary: 'orchestrator_provider' },
          async (child) => {
            runtime.recordEvent(child, {
              name: 'meri.provider.attempt.finalized',
              boundary: 'orchestrator_provider',
              outcome: 'completed',
              usage: meriTelemetryUsage(),
              sourceRefs: [
                { sourceId: 'PRIVATE_DOCUMENT_SECRET', version: 'PRIVATE_VERSION_SECRET' },
              ],
              rawPrompt: 'PRIVATE_PROMPT_SECRET',
              headers: { authorization: 'PRIVATE_AUTH_SECRET' },
              rawToolResult: 'PRIVATE_TOOL_SECRET',
            });
          },
        );
      },
      { preserveSpanIdentity: true },
    );
    await runtime.forceFlush();
    if (!bodies.length) throw new Error('no real OTLP request received');
    process.stdout.write(JSON.stringify({ root, bodies }));
  } finally {
    await runtime.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
