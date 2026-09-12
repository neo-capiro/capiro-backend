import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { RecordingStorageService } from '../../src/hearing/recording/recording-storage.service.js';
async function main() {
  if (process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable')
    throw Error('Explicit qualification required');
  const storage = new RecordingStorageService(new ConfigService());
  const tenant = 'qualification-' + randomUUID(),
    recording = randomUUID(),
    epoch = randomUUID();
  const bytes = Buffer.from('owned LegiWatch qualification fixture');
  const key = `hearing-audio/${tenant}/${recording}/${epoch}/probe`,
    hash = createHash('sha256').update(bytes).digest('hex');
  const started = Date.now();
  await storage.put(key, bytes, bytes.length, hash);
  await storage.put(key, bytes, bytes.length, hash);
  const chunks = [];
  for await (const chunk of await storage.read(key)) chunks.push(Buffer.from(chunk));
  if (!Buffer.concat(chunks).equals(bytes)) throw Error('Readback mismatch');
  await storage.purgeRecording(tenant, recording);
  console.log(
    JSON.stringify({
      event: 's3_immutable_readback_and_version_purge_passed',
      elapsedMs: Date.now() - started,
    }),
  );
}
void main().catch((e) => {
  console.error(JSON.stringify({ event: 's3_probe_failed', name: e.name, message: e.message }));
  process.exitCode = 1;
});
