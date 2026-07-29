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
 */
const MERI_ROOT = __dirname;

function read(name: string): string {
  return readFileSync(join(MERI_ROOT, name), 'utf8');
}

describe('Session client scope — the chat tool loop enforces, it does not default', () => {
  const text = read('meri.service.ts');

  it('refuses a clientId that is not the conversation client', () => {
    expect(text).toContain('let scopeViolation: string | undefined;');
    expect(text).toContain('clientScopeRefusal(await resolveSessionClientName())');
    // The pre-fix behaviour was a comment-documented default-only rule.
    expect(text).not.toContain(
      '// Default clientId from the conversation if the model omitted it.',
    );
  });

  it('still fills an OMITTED clientId from the conversation', () => {
    expect(text).toContain('parsedInput.clientId = conversation.clientId;');
  });

  it('short-circuits BEFORE the tool runs (a blocked read must not execute)', () => {
    const guard = text.indexOf('if (item.scopeViolation) {');
    const execute = text.indexOf('return this.tools.execute(ctx, item.tool.name as never');
    expect(guard).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(guard);
  });

  it('does not let a refusal move a tool circuit breaker', () => {
    expect(text).toContain('if (item.scopeViolation) continue;');
  });

  it('enforces on NATIVE tools only — a bridged MCP clientId is a foreign namespace', () => {
    expect(text).toContain('if (conversation.clientId && !isBridged) {');
  });

  it('resolves an exact client NAME for this session rather than refusing it', () => {
    // find_contacts documents a name in clientId; a name that IS this session's
    // client must resolve, not cost the user a refusal round-trip.
    expect(text).toContain('CLIENT_ID_UUID_RE.test(supplied)');
    expect(text).toContain('supplied.toLowerCase() === nameToMatch.toLowerCase()');
  });

  it('states the scope in the system prompt, in the uncached per-turn tail', () => {
    expect(text).toContain('if (activeClient) tail.push(clientScopeDirective(activeClient.name));');
    expect(text).toContain('orchestration.activeClient');
    // Must NOT be appended to the cached base — that prefix is shared across
    // conversations, so a per-conversation client would poison it.
    const base = text.indexOf('const base = [');
    const baseEnd = text.indexOf("].join('\\n');", base);
    expect(text.slice(base, baseEnd)).not.toContain('clientScopeDirective');
  });

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
    const execute = text.indexOf('resultPayload = await this.tools.execute(ctx, t.name as never');
    expect(guard).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(guard);
  });
});

describe('Session client scope — the firm-wide tool readers honour the pinned client', () => {
  const text = read('meri-tools.service.ts');

  it('search_memory filters memory_items by the session client', () => {
    // Same predicate shape as meri.service.ts projectionRecall: firm-wide items
    // (client_id NULL) stay visible; another client's items do not.
    expect(text).toContain(
      'AND ($3::uuid IS NULL OR mi.client_id IS NULL OR mi.client_id = $3::uuid)',
    );
    expect(text).toContain('scopeClientId ?? null,');
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
    const rejections =
      text.match(/if \(scopeClientId && !CLIENT_ID_UUID_RE\.test\(scopeClientId\)\)/g) ?? [];
    expect(rejections.length).toBe(3);
  });
});
