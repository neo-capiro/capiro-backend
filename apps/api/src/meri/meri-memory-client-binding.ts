const CLIENT_SCOPED_MEMORY_TOOLS = new Set([
  'save_memory',
  'search_memory',
  'list_memory_proposals',
]);

/** Remove model-provided client scope when no client is selected in chat. */
export function bindUnscopedMemoryTool(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; refusal?: string } {
  if (!CLIENT_SCOPED_MEMORY_TOOLS.has(toolName)) return { input };
  const requestedClient = input.clientId !== undefined && input.clientId !== null &&
    String(input.clientId).trim() !== '';
  const requestedClientSave = toolName === 'save_memory' &&
    typeof input.scope === 'string' && input.scope.trim().toLowerCase() === 'client';
  const bound = { ...input, clientId: null };
  if (requestedClient || requestedClientSave) {
    return {
      input: bound,
      refusal: 'No client is selected for this conversation. Select a client before using client-scoped memory.',
    };
  }
  return { input: bound };
}
