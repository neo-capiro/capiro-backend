import { createHash } from 'node:crypto';

// Exact PR2444/PR2446 declaration inverse for preservation guards, never a general
// manifest exception. No I/O, process, environment or application imports.
export const REVIEWED_PE_MANIFEST_SOURCE = '457e84e7d50f401985355cf22eedc480fd72ad8b';
export const REVIEWED_PE_API_MANIFEST_SOURCE = 'e25b2c9ad93ae8d63ffb5332c41d7af1623d4400';
const profiles = Object.freeze({
  root: Object.freeze({
    after: 'ffbc080178b4e4767abaa05932e7c7b3fc4f80bc33206ebc9c7beb8a9a474824',
    before: '709c2b40e3e54112784fd2670faa999ce701edca1f879bafb26a131c3820f728',
    additions: [
      '    "verify:pe-phase-9:backend": "pnpm -C apps/api run verify:pe-phase-9:backend",\n',
      '    "verify:pe-phase-9:backend:dry-run": "pnpm -C apps/api run verify:pe-phase-9:backend:dry-run",\n',
    ],
  }),
  api: Object.freeze({
    after: 'cf3d355d8d8595f52cae8bb6e1ae0142be545f316e74c68f4907bc012515aa9a',
    before: 'cb0ade4fbb794c20b1c0e7779c1f61e2de927a3ba9ad138f5088d25b1dce88ff',
    additions: [
      '    "verify:pe-phase-9:backend": "tsx scripts/verify-pe-phase-9.ts --backend-only --run",\n',
      '    "verify:pe-phase-9:backend:dry-run": "tsx scripts/verify-pe-phase-9.ts --backend-only --dry-run",\n',
      ' scripts/lib/pe-phase-9-backend-scope.spec.ts scripts/lib/pe-phase-9-runner.spec.ts',
      '    "test:pe-phase-9-migration-discovery": "node --test scripts/lib/pe-phase-9-migration-discovery.spec.mjs scripts/lib/pe-phase-9-owned-postgres.spec.mjs",\n',
      'pnpm run test:pe-phase-9-migration-discovery && ',
    ],
  }),
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function restoreReviewedPeManifest(source, kind) {
  if (!['root', 'api'].includes(kind) ||
      !(typeof source === 'string' || Buffer.isBuffer(source)))
    throw new Error('Exact reviewed PE manifest bytes and literal kind required');
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const profile = profiles[kind];
  if (sha(bytes) !== profile.after)
    throw new Error('Unreviewed PE manifest change refused');
  let text = bytes.toString('utf8');
  for (const addition of profile.additions) {
    if (text.split(addition).length !== 2)
      throw new Error('Exact single reviewed PE manifest operand required');
    text = text.replace(addition, '');
  }
  if (sha(Buffer.from(text)) !== profile.before)
    throw new Error('Prior manifest byte identity did not reconstruct');
  return text;
}
