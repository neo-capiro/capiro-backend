import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Finite backend-workspace retirement at the exact Engagement successor source.
// An exact inverse of reviewed source bytes, never a package/lock or gate waiver.
// checkoutAfter admits only the known CRLF checkout representation; output is
// the canonical prior Git blob. Unknown bytes are refused before normalization.
export const BACKEND_WORKSPACE_TRANSITION_SOURCE = '016e79b585c14f20d13669e13c987c01e3dd29dd';
const transitionHashes = {
  "package.json": {
    "before": "ffbc080178b4e4767abaa05932e7c7b3fc4f80bc33206ebc9c7beb8a9a474824",
    "after": "5bbfb38f057af67a635f4f86ecb23694fd626ee2e2a9382bcb3ff192960089a0",
    "checkoutAfter": "5bbfb38f057af67a635f4f86ecb23694fd626ee2e2a9382bcb3ff192960089a0"
  },
  "pnpm-workspace.yaml": {
    "before": "d60a0f353c3a1ad1909e928324a367b956c573178eba98e8004342d43517ab4d",
    "after": "9d56f16020e0229e5724e629b4b9db4eec960f69c571cff5659585b839c2de07",
    "checkoutAfter": "72713cfac133d8a446ae651a1ea4043b2bbce9d15b14048cc671f77eccc8bee7"
  },
  "pnpm-lock.yaml": {
    "before": "01f689e46dc06cdd1d9e8a0c96e5b6e70ac6f462fe2ab9c05813317a053c643c",
    "after": "c40a4e5d624cf42f498a1ec0fb87851d970a7395d55afdb3c9e7cbbe38ced948",
    "checkoutAfter": "113ec790b45ce20eda92dd1d4a7578a304ad6085011f747180ceefa22a830ff3"
  }
};
export const BACKEND_WORKSPACE_TRANSITION_HASHES = Object.freeze(Object.fromEntries(
  Object.entries(transitionHashes).map(([file, profile]) => [file, Object.freeze(profile)]),
));
const scriptChanges = [
  [
    "build",
    "turbo run build",
    "turbo run build --filter=\"!@capiro/onboard-web\" --filter=\"!@capiro/e2e\""
  ],
  [
    "dev",
    "turbo run dev",
    "turbo run dev --filter=\"!@capiro/onboard-web\" --filter=\"!@capiro/e2e\""
  ],
  [
    "lint",
    "turbo run lint",
    "turbo run lint --filter=\"!@capiro/onboard-web\" --filter=\"!@capiro/e2e\""
  ],
  [
    "typecheck",
    "turbo run typecheck",
    "pnpm typecheck:backend"
  ],
  [
    "test",
    "turbo run test",
    "turbo run test --filter=\"!@capiro/onboard-web\" --filter=\"!@capiro/e2e\""
  ],
  [
    "verify:research-portfolios-phases0-4",
    "pnpm verify:research-portfolios-phase0 && node scripts/verify-research-portfolios-phases1-4.mjs",
    "pnpm verify:research-portfolios-phase0 && node scripts/verify-research-portfolios-phases1-4.mjs --backend-only"
  ],
  [
    "verify:engagement-phase-1",
    "pnpm --filter @capiro/api exec tsx scripts/verify-engagement-phase1-runtime.ts --run && node --check scripts/run-engagement-phase1-local.mjs && node --check scripts/verify-engagement-phase1-local.mjs && node --check scripts/run-engagement-phase1-post-acceptance.mjs && node --check scripts/verify-engagement-phase1-background-final.mjs && node --check apps/web/scripts/engagement-phase1-browser-parity.mjs && node --check apps/web/scripts/engagement-phase1-post-acceptance.mjs",
    "pnpm verify:engagement-phase-1:backend"
  ],
  [
    "verify:engagement-phase-2",
    "bash scripts/verify-engagement-phase2-code.sh",
    "pnpm verify:engagement-phase-2:backend"
  ],
  [
    "verify:engagement-phase-3",
    "node scripts/verify-engagement-phase3-code.mjs --run",
    "pnpm verify:engagement-phase-3:backend"
  ],
  [
    "verify:outreach-v3-phase-1",
    "node scripts/verify-outreach-v3-phase1-code.mjs --run",
    "pnpm verify:outreach-v3-phase-1:backend"
  ],
  [
    "verify:outreach-v3-phase-2",
    "node scripts/verify-outreach-v3-phase2-code.mjs --run",
    "node scripts/verify-outreach-v3-phase2-code.mjs --run --backend-only"
  ],
  [
    "verify:outreach-v3-phase-3",
    "node scripts/verify-outreach-v3-phase3-code.mjs --run",
    "pnpm verify:outreach-v3-phase-3:backend"
  ],
  [
    "verify:outreach-v3-phase-4",
    "node scripts/verify-outreach-v3-phase4-code.mjs --run",
    "pnpm verify:outreach-v3-phase-4:backend"
  ],
  [
    "verify:outreach-v3-phase-5",
    "node scripts/verify-outreach-v3-phase5-code.mjs --run",
    "node scripts/verify-outreach-v3-phase5-code.mjs --run --backend-only"
  ],
  [
    "verify:outreach-v3-phase-6",
    "node scripts/verify-outreach-v3-phase6-code.mjs --run",
    "node scripts/verify-outreach-v3-phase6-code.mjs --run --backend-only"
  ],
  [
    "validate:knowledge-plane:phase26",
    "node scripts/validate-knowledge-plane-phase26.mjs --run",
    "node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only"
  ],
  [
    "validate:knowledge-plane:phase26:fast",
    "node scripts/validate-knowledge-plane-phase26.mjs --run --skip-tests",
    "node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only --skip-tests"
  ],
  [
    "validate:knowledge-plane:phase26:frontend",
    "node scripts/validate-knowledge-plane-phase26.mjs --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web validate:knowledge-plane:phase26:frontend"
  ],
  [
    "typecheck:backend",
    "turbo run typecheck --concurrency=1 --filter='!@capiro/web' --filter='!@capiro/onboard-web'",
    "turbo run typecheck --concurrency=1 --filter=\"!@capiro/onboard-web\" --filter=\"!@capiro/e2e\""
  ],
  [
    "typecheck:frontend",
    "turbo run typecheck --concurrency=1 --filter=@capiro/web --filter=@capiro/onboard-web",
    "turbo run typecheck --concurrency=1 --filter=@capiro/onboard-web"
  ],
  [
    "verify:engagement-phase-1:frontend",
    "pnpm --filter @capiro/api exec tsx scripts/verify-engagement-phase1-runtime.ts --run --frontend-only && node --check apps/web/scripts/engagement-phase1-browser-parity.mjs && node --check apps/web/scripts/engagement-phase1-post-acceptance.mjs",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:engagement-phase-1:frontend"
  ],
  [
    "verify:engagement-phase-2:frontend",
    "bash scripts/verify-engagement-phase2-code.sh --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:engagement-phase-2:frontend"
  ],
  [
    "verify:engagement-phase-3:frontend",
    "node scripts/verify-engagement-phase3-code.mjs --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:engagement-phase-3:frontend"
  ],
  [
    "verify:outreach-v3-phase-1:frontend",
    "node scripts/verify-outreach-v3-phase1-code.mjs --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:outreach-v3-phase-1:frontend"
  ],
  [
    "verify:outreach-v3-phase-3:frontend",
    "node scripts/verify-outreach-v3-phase3-code.mjs --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:outreach-v3-phase-3:frontend"
  ],
  [
    "verify:outreach-v3-phase-4:frontend",
    "node scripts/verify-outreach-v3-phase4-code.mjs --run --frontend-only",
    "node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web verify:outreach-v3-phase-4:frontend"
  ]
];
export const RETIRED_MAIN_WEB_ALIASES = Object.freeze([
  "validate:knowledge-plane:phase26:frontend",
  "verify:engagement-phase-1:frontend",
  "verify:engagement-phase-2:frontend",
  "verify:engagement-phase-3:frontend",
  "verify:outreach-v3-phase-1:frontend",
  "verify:outreach-v3-phase-3:frontend",
  "verify:outreach-v3-phase-4:frontend"
]);
const retiredWebImporter = String.raw`  apps/web:
    dependencies:
      '@ant-design/icons':
        specifier: ^5.5.1
        version: 5.6.1(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@capiro/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      '@capiro/strategy-verifier':
        specifier: workspace:*
        version: link:../../packages/strategy-verifier
      '@clerk/clerk-react':
        specifier: ^5.7.0
        version: 5.61.3(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@tailwindcss/vite':
        specifier: ^4
        version: 4.3.3(vite@5.4.21(@types/node@26.6.3)(lightningcss@1.32.0)(terser@5.46.2))
      '@tanstack/react-query':
        specifier: ^5.104.0
        version: 5.104.0(react@18.3.1)
      '@tanstack/react-virtual':
        specifier: ^3.14.13
        version: 3.14.13(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@vis.gl/react-maplibre':
        specifier: ^8.1.3
        version: 8.1.3(maplibre-gl@5.24.0)(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@xyflow/react':
        specifier: ^12.12.0
        version: 12.12.0(@types/react-dom@18.3.7(@types/react@18.3.28))(@types/react@18.3.28)(immer@11.1.18)(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      antd:
        specifier: ^5.21.2
        version: 5.29.3(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      axios:
        specifier: ^1.20.0
        version: 1.20.0(debug@4.4.3)
      cytoscape:
        specifier: ^3.34.3
        version: 3.34.3
      cytoscape-fcose:
        specifier: ^2.2.0
        version: 2.2.0(cytoscape@3.34.3)
      hls.js:
        specifier: ^1.7.3
        version: 1.7.3
      html2canvas:
        specifier: 1.4.1
        version: 1.4.1
      jspdf:
        specifier: 2.5.1
        version: 2.5.1
      lucide-react:
        specifier: ^1.48.0
        version: 1.48.0(react@18.3.1)
      maplibre-gl:
        specifier: ^5
        version: 5.24.0
      react:
        specifier: ^18.3.1
        version: 18.3.1
      react-aria-components:
        specifier: ^1
        version: 1.21.1(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      react-cytoscapejs:
        specifier: ^2.0.0
        version: 2.0.0(cytoscape@3.34.3)(react@18.3.1)
      react-dom:
        specifier: ^18.3.1
        version: 18.3.1(react@18.3.1)
      react-markdown:
        specifier: ^9
        version: 9.1.0(@types/react@18.3.28)(react@18.3.1)
      react-router-dom:
        specifier: ^6.26.2
        version: 6.30.3(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      recharts:
        specifier: ^3.10.1
        version: 3.10.1(@types/react@18.3.28)(react-dom@18.3.1(react@18.3.1))(react-is@18.3.1)(react@18.3.1)(redux@5.0.1)
      rehype-sanitize:
        specifier: ^6
        version: 6.0.0
      remark-gfm:
        specifier: ^4
        version: 4.0.1
      tailwind-merge:
        specifier: ^3.7.0
        version: 3.7.0
      tailwindcss:
        specifier: ^4
        version: 4.3.3
    devDependencies:
      '@vitest/coverage-v8':
        specifier: ^2.1.9
        version: 2.1.9(vitest@2.1.9(@types/node@26.6.3)(jsdom@29.1.1(@noble/hashes@1.8.0))(lightningcss@1.32.0)(terser@5.46.2))
      '@testing-library/jest-dom':
        specifier: ^6.9.1
        version: 6.9.1
      '@testing-library/react':
        specifier: ^16.3.3
        version: 16.3.3(@testing-library/dom@10.4.1)(@types/react-dom@18.3.7(@types/react@18.3.28))(@types/react@18.3.28)(react-dom@18.3.1(react@18.3.1))(react@18.3.1)
      '@types/cytoscape':
        specifier: ^3.21.0
        version: 3.31.0
      '@types/react':
        specifier: ^18.3.11
        version: 18.3.28
      '@types/react-cytoscapejs':
        specifier: ^1.2.0
        version: 1.2.6
      '@types/react-dom':
        specifier: ^18.3.0
        version: 18.3.7(@types/react@18.3.28)
      '@vitejs/plugin-react':
        specifier: ^4.3.2
        version: 4.7.0(vite@5.4.21(@types/node@26.6.3)(lightningcss@1.32.0)(terser@5.46.2))
      chrome-launcher:
        specifier: ^1.1.2
        version: 1.2.1
      jsdom:
        specifier: ^29.1.1
        version: 29.1.1(@noble/hashes@1.8.0)
      lighthouse:
        specifier: 12.8.2
        version: 12.8.2
      typescript:
        specifier: ^5.5.4
        version: 5.9.3
      vite:
        specifier: ^5.4.8
        version: 5.4.21(@types/node@26.6.3)(lightningcss@1.32.0)(terser@5.46.2)
      vitest:
        specifier: ^2.1.9
        version: 2.1.9(@types/node@26.6.3)(jsdom@29.1.1(@noble/hashes@1.8.0))(lightningcss@1.32.0)(terser@5.46.2)
      vitest-axe:
        specifier: ^0.1.0
        version: 0.1.0(vitest@2.1.9(@types/node@26.6.3)(jsdom@29.1.1(@noble/hashes@1.8.0))(lightningcss@1.32.0)(terser@5.46.2))

`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2)
    throw new Error('Exact single backend-workspace transition operand required');
  return source.replace(from, to);
}

export function restoreBackendWorkspaceSource(source, file) {
  if (typeof file !== 'string' || !Object.hasOwn(BACKEND_WORKSPACE_TRANSITION_HASHES, file) ||
      !(typeof source === 'string' || Buffer.isBuffer(source)))
    throw new Error('Exact backend-workspace bytes and literal finite path required');
  const bytes = typeof source === 'string' ? Buffer.from(source) : source;
  const profile = BACKEND_WORKSPACE_TRANSITION_HASHES[file];
  const identity = sha(bytes);
  if (identity !== profile.after && identity !== profile.checkoutAfter)
    throw new Error('Unreviewed backend-workspace transition refused');
  let text = bytes.toString('utf8');
  if (identity !== profile.after) text = text.replace(/\r\n/g, '\n');
  if (sha(Buffer.from(text)) !== profile.after)
    throw new Error('Exact canonical backend-workspace source required');
  if (file === 'package.json') {
    for (const [key, before, after] of scriptChanges) {
      const line = value => '    ' + JSON.stringify(key) + ': ' + JSON.stringify(value) + ',\n';
      text = replaceOnce(text, line(after), line(before));
    }
  } else if (file === 'pnpm-workspace.yaml') {
    text = replaceOnce(text, '  - "!apps/web"\n', '');
  } else {
    text = replaceOnce(text, '  apps/workspace:\n', retiredWebImporter + '  apps/workspace:\n');
  }
  if (sha(Buffer.from(text)) !== profile.before)
    throw new Error('Prior backend-workspace byte identity did not reconstruct');
  return text;
}

export function mainWebRetirementResult(args) {
  if (Array.isArray(args) && args.length === 1 && ['--help', '-h'].includes(args[0]))
    return { status: 0, message: 'Usage: node scripts/lib/backend-workspace-retirement.mjs --refuse-main-web <retired-alias>\n' };
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--refuse-main-web' ||
      !RETIRED_MAIN_WEB_ALIASES.includes(args[1]))
    return { status: 2, message: 'Exact retired main-Web alias required; use --help for the finite interface.\n' };
  return {
    status: 2,
    message: 'Main Web source is retired from the backend workspace; ' + args[1] +
      ' is unavailable here. Historical main-Web evidence remains at its pinned source checkpoint. ' +
      'Retained Onboard typing is available through pnpm typecheck:frontend.\n',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = mainWebRetirementResult(process.argv.slice(2));
  (result.status === 0 ? process.stdout : process.stderr).write(result.message);
  process.exitCode = result.status;
}
