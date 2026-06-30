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

async function main(): Promise<void> {
  if (process.env.MERIV2_PARITY_LIVE === '1') {
    throw new Error(
      'Live parity runners are not wired in this environment — they require a running ' +
        'api + meriv2-orchestrator + DB + model. See docs/plans/2026-06-30-meriv2-REPORT.md.',
    );
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

  const res = await runSurface('in-editor[self-check]', inEditorFixtures, offRunner, onRunner, IN_EDITOR_POLICY);
  // eslint-disable-next-line no-console
  console.log(`Self-check: ${res.total - res.failed}/${res.total} parity-identical (diff mechanics OK).`);
  // eslint-disable-next-line no-console
  console.log(
    `Corpus: in-editor=${inEditorFixtures.length}, workspace-gen=${workspaceGenFixtures.length} (>= 20 each).`,
  );
  // eslint-disable-next-line no-console
  console.log('LIVE both-paths parity is GATED (MERIV2_PARITY_LIVE=1 + running stack). See REPORT.');
  if (res.failed > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
