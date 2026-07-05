import { diffResponses, type ParityFieldPolicy } from './diff';
import { inEditorFixtures, workspaceGenFixtures } from './fixtures';

/**
 * Parity runner (SC0.3). For the fixed corpus (N >= 20 per surface) it runs
 * BOTH paths (flag OFF vs ON) and diffs each pair. The live path runners (the
 * in-process surface + the orchestrator) require a running api + orchestrator +
 * DB + model; those are injected by the live harness (MERIV2_PARITY_LIVE=1).
 *
 * Absent the live stack, this runs a SELF-CHECK that exercises the diff
 * mechanics over the real corpus with synthetic responses, proving the harness
 * works and reporting the corpus size. The live diff is the gate before any
 * tenant is flagged ON.
 */
type PathRunner<I> = (input: I) => Promise<unknown>;

const IN_EDITOR_POLICY: ParityFieldPolicy[] = [
  { path: 'edits.length', kind: 'deterministic' },
  { path: 'structuralWarnings.length', kind: 'deterministic' },
  { path: 'reply', kind: 'graded' },
];

async function runSurface<I extends { id: string }>(
  surface: string,
  fixtures: I[],
  off: PathRunner<I>,
  on: PathRunner<I>,
  policy: ParityFieldPolicy[],
): Promise<{ surface: string; total: number; failed: number }> {
  let failed = 0;
  for (const fx of fixtures) {
    const [a, b] = await Promise.all([off(fx), on(fx)]);
    const result = diffResponses(fx.id, a, b, policy);
    if (!result.pass) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.log(`[DIFF] ${surface}/${fx.id}: ${JSON.stringify(result.mismatches)}`);
    }
  }
  return { surface, total: fixtures.length, failed };
}

const WORKSPACE_GEN_POLICY: ParityFieldPolicy[] = [
  { path: 'documents.length', kind: 'deterministic' },
  { path: 'docTitle', kind: 'graded' },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Live parity requires env ${name}`);
  return v;
}

async function postJson(url: string, bearer: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * A4 — live both-paths parity (SC0.3). Requires a running stack + env:
 *   PARITY_API_BASE_URL   e.g. https://app.capiro.ai/api      (legacy in-editor)
 *   PARITY_ORCH_BASE_URL  e.g. https://app.capiro.ai          (orchestrator)
 *   PARITY_WS_BASE_URL    e.g. https://app.capiro.ai/workspace-api (legacy gen)
 *   PARITY_BEARER_TOKEN   a valid Clerk session JWT for the pilot tenant
 *   PARITY_CLIENT_ID      real client id substituted into in-editor fixtures
 *   PARITY_DRAFT_ID       real draft id substituted into workspace-gen fixtures
 * Fixture tenant/client/draft ids are synthetic — the remap swaps in real ids
 * so the corpus runs against actual rows. NOTE: the orchestrator surface
 * endpoints (A3) must exist for the ON path; until then the ON runner fails
 * loudly — a wired-but-red harness is the correct pre-A3 state, never a silent
 * skip.
 */
async function runLive(): Promise<void> {
  const apiBase = requireEnv('PARITY_API_BASE_URL').replace(/\/+$/, '');
  const orchBase = requireEnv('PARITY_ORCH_BASE_URL').replace(/\/+$/, '');
  const bearer = requireEnv('PARITY_BEARER_TOKEN');
  const clientId = requireEnv('PARITY_CLIENT_ID');

  const results = [] as Array<{ surface: string; total: number; failed: number }>;

  results.push(
    await runSurface(
      'in-editor[live]',
      inEditorFixtures,
      (fx) => postJson(`${apiBase}/workspace/assistant`, bearer, { ...fx.dto, clientId }),
      (fx) => postJson(`${orchBase}/meri-api/in-editor-assistant`, bearer, { ...fx.dto, clientId }),
      IN_EDITOR_POLICY,
    ),
  );

  // Workspace-gen live parity is heavier (each call regenerates a real draft
  // and writes ws_draft.config); it runs only when the extra env is present.
  const wsBase = process.env.PARITY_WS_BASE_URL?.replace(/\/+$/, '');
  const draftId = process.env.PARITY_DRAFT_ID;
  if (wsBase && draftId) {
    results.push(
      await runSurface(
        'workspace-gen[live]',
        workspaceGenFixtures.slice(0, 1), // one real regeneration per run — it mutates the draft
        () => postJson(`${wsBase}/drafts/${draftId}/generate-all`, bearer, {}),
        () =>
          postJson(`${orchBase}/meri-api/workspace-generation`, bearer, {
            tenantId: 'ignored-resolved-from-jwt',
            draftId,
          }),
        WORKSPACE_GEN_POLICY,
      ),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      'workspace-gen[live]: SKIPPED (set PARITY_WS_BASE_URL + PARITY_DRAFT_ID to run) — not silently passed.',
    );
  }

  let failed = 0;
  for (const r of results) {
    failed += r.failed;
    // eslint-disable-next-line no-console
    console.log(`${r.surface}: ${r.total - r.failed}/${r.total} parity-identical.`);
  }
  if (failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  if (process.env.MERIV2_PARITY_LIVE === '1') {
    await runLive();
    return;
  }

  // Self-check: deterministic fields identical → pass; graded reply differs but
  // both non-empty → pass. Proves the harness mechanics over the real corpus.
  const offRunner = async (f: { id: string }) => ({
    id: f.id,
    edits: [{ op: 'replace_section' }],
    structuralWarnings: [],
    reply: 'Grounded answer A.',
  });
  const onRunner = async (f: { id: string }) => ({
    id: f.id,
    edits: [{ op: 'replace_section' }],
    structuralWarnings: [],
    reply: 'Grounded answer B (semantically equivalent).',
  });

  const res = await runSurface(
    'in-editor[self-check]',
    inEditorFixtures,
    offRunner,
    onRunner,
    IN_EDITOR_POLICY,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Self-check: ${res.total - res.failed}/${res.total} parity-identical (diff mechanics OK).`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Corpus: in-editor=${inEditorFixtures.length}, workspace-gen=${workspaceGenFixtures.length} (>= 20 each).`,
  );
  // eslint-disable-next-line no-console
  console.log(
    'LIVE both-paths parity is GATED (MERIV2_PARITY_LIVE=1 + running stack). See REPORT.',
  );
  if (res.failed > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
