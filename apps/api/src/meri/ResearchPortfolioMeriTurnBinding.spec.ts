import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { bindResearchPortfolioToolConversation } from './meri-research-portfolio-tool-scope.js';
const currentConversationId = '11111111-1111-4111-8111-111111111111';
const otherOwnedConversationId = '22222222-2222-4222-8222-222222222222';
const names = [
  'get_research_portfolio',
  'get_research_portfolio_analytics',
  'get_research_portfolio_changes',
  'create_research_portfolio_snapshot',
  'request_research_portfolio_output',
  'save_research_portfolio_output_to_client',
  'watch_research_portfolio',
  'update_research_portfolio_change_state',
  'get_research_portfolio_bookmarks',
  'create_research_portfolio_bookmark',
  'get_research_portfolio_fit',
  'get_research_portfolio_reviews',
  'add_research_portfolio_review_note',
  'get_research_portfolio_rules',
  'get_research_portfolio_imports',
  'get_research_portfolio_operations',
  'prepare_research_portfolio_brief',
  'prepare_research_portfolio_meeting',
  'manage_research_portfolio',
];
function fragments() {
  const source = readFileSync(join(__dirname, 'meri.service.ts'), 'utf8'),
    ast = ts.createSourceFile('meri.service.ts', source, ts.ScriptTarget.Latest, true);
  let normalization = '',
    dispatch = '';
  function walk(node: ts.Node): void {
    if (
      ts.isForOfStatement(node) &&
      node.expression.getText(ast) === 'orderedTools.entries()' &&
      ts.isBlock(node.statement)
    ) {
      const body = node.statement.getText(ast).slice(1, -1),
        end = body.indexOf('toolsUsed.push(t.name);');
      if (end >= 0)
        normalization = body.slice(0, end) + 'captures.push({parsedInput,scopeViolation});';
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'runToolsConcurrently') {
      const callback = node.arguments[1];
      if (
        callback &&
        ts.isArrowFunction(callback) &&
        ts.isBlock(callback.body) &&
        callback.body
          .getText(ast)
          .includes('return this.tools.execute(ctx, item.tool.name as never')
      )
        dispatch = callback.body.getText(ast).slice(1, -1);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  if (!normalization || !dispatch)
    throw Error('Actual Meri normalization/dispatch fragment unavailable');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return {
    normalize: new AsyncFunction(
      't',
      'conversationId',
      'conversation',
      'parseBridgedToolName',
      'bindResearchPortfolioToolConversation',
      'captures',
      ts.transpile(normalization, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      }),
    ),
    dispatch: new AsyncFunction(
      'item',
      'ctx',
      'parseBridgedToolName',
      'CircuitOpenError',
      ts.transpile(dispatch, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }),
    ),
  };
}
async function actual(name: string, input: Record<string, unknown>) {
  const f = fragments(),
    captures: any[] = [],
    execute = jest.fn(async (_ctx: unknown, _tool: string, body: Record<string, unknown>) => ({
      portfolio:
        body.conversationId === otherOwnedConversationId
          ? 'Other owned portfolio'
          : 'Original turn portfolio',
    }));
  await f.normalize(
    { name, jsonParts: [JSON.stringify(input)] },
    currentConversationId,
    { clientId: null },
    () => null,
    bindResearchPortfolioToolConversation,
    captures,
  );
  const normalized = captures[0];
  if (!normalized) throw Error('Missing actual normalization capture');
  const result = await f.dispatch.call(
    { tools: { execute, isSideEffecting: () => false }, toolBreaker: { isOpen: () => false } },
    { ...normalized, tool: { name } },
    { tenantId: 'owned-tenant', userId: 'owned-actor' },
    () => null,
    Error,
  );
  return { normalized, result, execute };
}
describe('Current-turn Research Portfolio tool binding', () => {
  it.each(names)(
    'actual normalization refuses model retargeting for %s before actual native dispatch',
    async (name) => {
      const observed = await actual(name, { conversationId: otherOwnedConversationId });
      expect(observed.result).toEqual(
        expect.objectContaining({ ok: false, error: expect.stringContaining('current chat') }),
      );
      expect(observed.execute).not.toHaveBeenCalled();
    },
  );
  it('injects omitted current conversation and retains exact current conversation', async () => {
    for (const input of [{}, { conversationId: currentConversationId }]) {
      const observed = await actual('get_research_portfolio', input);
      expect(observed.result).toEqual({ portfolio: 'Original turn portfolio' });
      expect(observed.normalized.parsedInput.conversationId).toBe(currentConversationId);
      expect(observed.execute).toHaveBeenCalledTimes(1);
    }
  });
  it('ordinary native tools preserve their existing supplied conversation treatment', async () => {
    const observed = await actual('search_memory', {
      conversationId: otherOwnedConversationId,
      query: 'funding',
    });
    expect(observed.result).toEqual({ portfolio: 'Other owned portfolio' });
    expect(observed.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects null/empty/non-string scope attempts without rewriting them as a successful current request', async () => {
    for (const conversationId of [null, '', 23]) {
      const observed = await actual('get_research_portfolio', { conversationId });
      expect(observed.result).toEqual(expect.objectContaining({ ok: false }));
      expect(observed.execute).not.toHaveBeenCalled();
    }
  });
});
