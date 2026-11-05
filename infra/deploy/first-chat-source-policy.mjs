import { createHash } from 'node:crypto';

const forbiddenPath = /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.aws|\.ssh|id_rsa|id_ed25519|credentials\.json|service-account\.json)$|\.(?:pem|p12|pfx|key)$/i;
// Public RDS trust bundle, verified byte-for-byte against
// https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem .
const publicBundle = 'apps/api/scripts/funding-worker/rds-global-bundle.pem';
const publicBundleSha256 = '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b';

// Test-only input to the native build-stage probes; never a production COPY source.
export const nativePostgresHarnessPaths = Object.freeze([
  'apps/api/test/memory-postgres-qualification/harness.ts',
]);

export function sourcePathAllowed(path, readRawGitBlob) {
  if (path.startsWith('apps/api/test/')) return nativePostgresHarnessPaths.includes(path);
  if (!forbiddenPath.test(path)) return true;
  return path === publicBundle && createHash('sha256').update(readRawGitBlob()).digest('hex') === publicBundleSha256;
}
