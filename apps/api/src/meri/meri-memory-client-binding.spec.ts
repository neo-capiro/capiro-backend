import { bindUnscopedMemoryTool } from './meri-memory-client-binding.js';

describe('unscoped Meri memory tool binding', () => {
  const clientId = '11111111-1111-4111-8111-111111111111';

  it.each(['save_memory', 'search_memory', 'list_memory_proposals'])(
    'refuses model supplied client scope for %s', (toolName) => {
      const result = bindUnscopedMemoryTool(toolName, { clientId, query: 'budget' });
      expect(result.refusal).toContain('No client is selected');
      expect(result.input.clientId).toBeNull();
    },
  );

  it('refuses a client save even when the model omits clientId', () => {
    const result = bindUnscopedMemoryTool('save_memory', { scope: 'client', content: 'Budget' });
    expect(result.refusal).toContain('No client is selected');
    expect(result.input.clientId).toBeNull();
  });

  it('allows personal memory and firm-only search with null client scope', () => {
    const personal = bindUnscopedMemoryTool('save_memory', { scope: 'personal', content: 'Style' });
    const search = bindUnscopedMemoryTool('search_memory', { query: 'style' });
    expect(personal.refusal).toBeUndefined();
    expect(personal.input.clientId).toBeNull();
    expect(search.refusal).toBeUndefined();
    expect(search.input.clientId).toBeNull();
  });

  it('does not alter unrelated tool parameter namespaces', () => {
    const input = { clientId, query: 'mail' };
    expect(bindUnscopedMemoryTool('search_emails', input)).toEqual({ input });
  });
});
