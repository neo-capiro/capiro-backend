import { expect, test } from '@jest/globals';
import { isOutreachGenerationConversation } from './meri-conversation-bootstrap.js';
test('only server-purpose Outreach sessions are excluded from ordinary Meri views', () => {
  expect(isOutreachGenerationConversation({ metadata: { purpose: 'outreach_generation' } })).toBe(
    true,
  );
  expect(isOutreachGenerationConversation({ metadata: { runtime: 'claude-agent-sdk' } })).toBe(
    false,
  );
  expect(isOutreachGenerationConversation({ metadata: null })).toBe(false);
});
