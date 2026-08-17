import { assertDefenseServeEnvironment } from './defense-config.validation.js';

try {
  assertDefenseServeEnvironment();
  process.stdout.write(`${JSON.stringify({ ok: true, service: 'defense-api' })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      service: 'defense-api',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
}
