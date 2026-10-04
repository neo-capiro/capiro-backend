import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const allowed = new Set([
  'MERI_CASE01_SETUP_INPUT',
  'MERI_CAPTURE_PROVIDER_BUDGET_INPUT',
  'MERI_CONTROLLED_READ_SETUP_INPUT',
  'MERI_PENDING_MEMORY_SETUP_INPUT',
  'MERI_CASE14_RECALL_SETUP_INPUT',
  'MERI_CASE12_SETUP_PLAN_INPUT',
  'MERI_SYNTHETIC_READ_BUDGET_INPUT',
]);
const fail = () => {
  throw new Error('CASE01_OPERATOR_INPUT_INVALID');
};
/** Fixed nonsecret recipe ingress for one-off task overrides; no shell or file
 * creation through command text. Actual DATABASE_URL remains process-private. */
export async function readMeriOperatorInput(mode, locator, expectedVariable) {
  if (!allowed.has(expectedVariable)) fail();
  let bytes;
  if (mode === '--input' && isAbsolute(locator ?? '')) bytes = await readFile(locator);
  else if (mode === '--input-env' && locator === expectedVariable)
    bytes = Buffer.from(process.env[expectedVariable] ?? '', 'utf8');
  else fail();
  if (!bytes.length || bytes.length > 6000) fail();
  const input = JSON.parse(bytes.toString('utf8'));
  function inspect(value, depth = 0) {
    if (depth > 16) fail();
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (/password|secret|credential|authorization|cookie|databaseUrl|apiKey|session/iu.test(key))
        fail();
      inspect(nested, depth + 1);
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  inspect(input);
  return input;
}
