import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session client scope — static fail-closed guards.
 *
 * Reported live on 2026-07-29: a user working in a Meri session assigned to one
 * client got answers about OTHER clients. Four things were wrong at once, and
 * each of them is cheap to reintroduce, so each is pinned here:
 *
 *   1. DISPATCH — both tool loops (chat + Deep Research) only DEFAULTED
 *      `clientId` from the conversation when the model omitted it. A different
 *      client id sailed through, and `ensureClientVisible` checks tenant +
 *      not-archived, not scope. Now a mismatch is refused, and the refusal is
 *      returned INSTEAD of executing the tool.
 *   2. FIRM-WIDE READERS — search_memory / query_knowledge_graph / find_path_to
 *      have no `clientId` in their model-facing schema, so they ignored the
 *      pinned scope and read across every client. They now honour it.
 *   3. PROMPT — nothing told the model the session was a boundary. A hard
 *      client-scope directive is threaded into the per-turn (uncached) tail.
 *   4. ROSTER — the firm's full client roster is injected on every turn; in a
 *      scoped session it now says outright that it is a lookup list only.
 *
 * Pure filesystem assertions, in the same spirit as
 * memory-wall-fail-closed.spec.ts: the enforcement lives inside very large
 * private streaming methods that a unit test cannot reach without a live model,
 * a live DB, and an SSE socket. The behavioural proof is the browser walk; this
 * catches a silent revert.
 *
 * Follow the enforcement, do not just re-point at this directory: #1502 moved
 * search_memory's client predicate out to the governed retrieval adapter, so
 * the last describe below reads ../retrieval/adapters. An assertion deleted
 * because the line it named moved is a guard that stopped being tested.
 */
const MERI_ROOT = __dirname;

function read(name: string): string {
  return readFileSync(join(MERI_ROOT, name), 'utf8');
}

/**
 * The body of one `private async <name>(` method. Guards are asserted per
 * reader rather than counted across the file: a total silently changes meaning
 * when a method is renamed, split or given a differently-named local, whereas a
 * per-reader assertion names the reader that lost its guard.
 */
function methodBody(source: string, method: string): string {
  const start = source.indexOf(`private async ${method}(`);
  if (start < 0) throw new Error(`meri-tools.service.ts no longer defines ${method}()`);
  const end = source.indexOf('\n  private ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

/**
 * The chat tool loop is no longer in apps/api. The in-process loop these pins
 * used to read was deleted with the MeriV2 transport; MeriService.streamMessage
 * is served by the V3 runtime proxy (meriv3-runtime.proxy.ts), and tool
 * dispatch for chat turns runs in the orchestrator's MeriV3AssistantService.
 * Its behaviour is pinned there (meriv3-assistant.service.spec.ts cross-client
 * cases asserting CROSS_CLIENT_REFUSAL; meriv3-managed-mcp-request-path.spec.ts).
 * These static pins follow the enforcement to that owner, so a silent revert of
 * the guard is still caught from here.
 */
describe('Session client scope — the current chat tool loop enforces, it does not default', () => {
  const text = read('../../../meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts');

  function augmentBody(): string {
    const start = text.indexOf('protected augmentToolInput(');
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('\n  protected ', start + 1));
  }

  it('consumes the scope guard before mutating the tool input', () => {
    const body = augmentBody();
    const guard = body.indexOf('if (scopeViolation) return { input: output, scopeViolation };');
    const mutation = body.indexOf('output.clientId =');
    expect(guard).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(guard);
  });

  it('refuses a clientId that is not the conversation client', () => {
    const body = augmentBody();
    const mismatch = body.indexOf('if (supplied && supplied !== dto.clientId) {');
    expect(mismatch).toBeGreaterThan(-1);
    expect(body.slice(mismatch)).toContain('return { input: output, scopeViolation: CROSS_CLIENT_REFUSAL };');
  });

  it('still fills an OMITTED clientId from the conversation', () => {
    expect(augmentBody()).toContain('if (supplied || !mailRead) output.clientId = dto.clientId;');
  });

  it('short-circuits BEFORE the tool runs (a blocked read must not execute)', () => {
    const guard = text.indexOf('return { blocked: true, error: scopeViolation };');
    const execute = text.indexOf('const definition = this.registry.get(args.name);');
    expect(guard).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(guard);
  });
});

describe('Session client scope — the retained client roster stays reference-only', () => {
  const text = read('meri.service.ts');

  it('marks the firm-wide client roster as reference-only in a scoped session', () => {
    expect(text).toContain('const scopeNote = activeClient');
    expect(text).toContain('use this list ONLY to answer questions about the roster itself');
  });
});

describe('Session client scope — the Deep Research tool loop enforces the same rule', () => {
  const text = read('meri-research.service.ts');

  it('refuses a clientId that is not the session client', () => {
    expect(text).toContain('let scopeViolation: string | undefined;');
    expect(text).toContain('clientScopeRefusal(await resolveSessionClientName())');
    expect(text).not.toContain('// Default clientId from the session if the model omitted it.');
  });

  it('still fills an OMITTED clientId from the session', () => {
    expect(text).toContain('parsedInput.clientId = session.clientId;');
  });

  it('short-circuits BEFORE the tool runs', () => {
    const guard = text.indexOf('if (scopeViolation) {');
    // Wrapper-agnostic on purpose. 2026-09-06 (#1507) moved the call inside
    // withMeriToolExecutionControl(..., () => this.tools.execute(...)), which
    // broke the old `resultPayload = await this.tools.execute(` literal without
    // touching the guard — a red test for a refactor that changed nothing about
    // scope. Match the call itself, and prove unreachability structurally.
    const execute = text.indexOf('this.tools.execute(ctx, t.name as never');
    expect(guard).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(guard);
    // Ordering alone would also be satisfied by an unrelated later statement.
    // What actually makes a blocked read impossible is that execution is an
    // ELSE arm of this same branch, so no scopeViolation path can reach it.
    expect(text.slice(guard, execute)).toContain('} else {');
  });
});

describe('Session client scope — the firm-wide tool readers honour the pinned client', () => {
  const text = read('meri-tools.service.ts');

  it('search_memory forwards the session client into governed retrieval', () => {
    // The predicate this used to assert here is gone, not weakened: 2026-09-06
    // (#1502) moved search_memory off its own raw SQL onto the shared governed
    // retrieval adapter, which applies the SAME firm-wide-plus-this-client rule
    // (pinned below in "governed memory retrieval"). What has to be pinned in
    // THIS file is the half that stayed: the tool must still hand the scoped
    // clientId to that adapter. Dropping it is one deleted line, it fails open
    // to every client's memory, and nothing else here would notice.
    const body = methodBody(text, 'searchMemory');
    expect(body).toContain("const clientId = optionalString(input, 'clientId', 80);");
    expect(body).toContain("domains: ['institutional_knowledge'],");
    expect(body).toContain('...(clientId ? { clientId } : {}),');
  });

  it('query_knowledge_graph walks only the scoped client subgraph', () => {
    expect(text).toContain('graph = restrictGraphToClient(full, scopeNode);');
    // An omitted seed must not fall through to the firm-wide graph.
    expect(text).toContain('effectiveSeed = seed || scopeNode;');
  });

  it('query_knowledge_graph refuses an explicit seed on another client', () => {
    expect(text).toContain("seed?.startsWith('client:') && seed !== scopeNode");
  });

  it('find_path_to searches from the scoped client only, and cannot route through another', () => {
    expect(text).toContain('restrictGraphToClient(loaded, `client:${scopeClientId}`)');
  });

  it('rejects a non-uuid clientId rather than silently ignoring the scope', () => {
    // Was a count of three identical `scopeClientId` guards. searchMemory's
    // rewrite (#1502) named its local `clientId`, so the count read 2 — a red
    // test for a rename that kept the guard. Assert the guard on each reader
    // instead: that says WHICH reader failed open, and survives a local rename.
    for (const reader of ['queryKnowledgeGraph', 'findPathTo', 'searchMemory'] as const) {
      const body = methodBody(text, reader);
      expect(body).toMatch(
        new RegExp(String.raw`if \((scopeClientId|clientId) && !CLIENT_ID_UUID_RE\.test\(\1\)\)`),
      );
      expect(body).toContain("error: 'clientId must be a client UUID");
    }
  });
});

/**
 * Where search_memory's client predicate lives since #1502. The tool no longer
 * owns SQL; it calls searchCapiroData -> MeriContextPlaneService.searchToolData
 * -> the governed retrieval gateway, which resolves subjectScope 'client' to
 * caller.clientIds = [thatClient]. This adapter is the last hop before the rows.
 */
describe('Session client scope — governed memory retrieval keeps the firm-wide/other-client split', () => {
  const text = read('../retrieval/adapters/institutional-knowledge-retrieval.adapter.ts');

  it('reads firm-wide memory plus the scoped client, and no other client', () => {
    const eligibility = read('../retrieval/adapters/governed-memory-eligibility.helpers.ts');
    expect(text).toContain('canonicalMemoryEligibilitySql');
    expect(eligibility).toContain(
      'AND (mi.client_id IS NULL OR mi.client_id = ANY(${allowedClientIds}::uuid[]))',
    );
    // Re-checked in JS after the query, so a predicate edit alone cannot leak.
    expect(eligibility).toContain('(!row.clientId || allowedClientIds.includes(row.clientId)) &&');
  });

  it('refuses the read outright rather than widening when the scope is not allowed', () => {
    // allowedClientIds is built by filtering the REQUESTED ids through the
    // ethical wall. If any is dropped the whole read is refused — it must never
    // continue with the narrowed-but-nonempty remainder, and an empty array
    // must never be read as "unscoped".
    expect(text).toContain('if (allowedClientIds.length !== requestedClientIds.length) {');
    expect(text).toContain("'requested_client_scope_failed_ethical_wall'");
    expect(text).toContain("'requested_client_scope_not_authorized'");
  });
});
