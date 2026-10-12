import { meriDocumentRequestFor } from './meriv3-assistant.service.js';

const fileAsk = [
  {
    role: 'user' as const,
    text: 'List every action item from the uploaded transcript in the client files.',
  },
];

describe('client-file read coordination applies to ordinary chat turns only', () => {
  it('an ordinary client chat turn that asks to read files is coordinated', () => {
    expect(meriDocumentRequestFor({ clientId: 'client-a', messages: fileAsk })).toMatchObject({
      completeRead: true,
    });
  });

  it('a research plan turn has no tools, so it is never held to a file read', () => {
    expect(
      meriDocumentRequestFor({ clientId: 'client-a', toolPolicy: 'none', messages: fileAsk }),
    ).toBeNull();
  });

  it('a research run turn owns its own evidence', () => {
    expect(
      meriDocumentRequestFor({
        clientId: 'client-a',
        toolPolicy: 'read-only',
        researchRun: { sessionId: 's', runId: 'r', leaseEpoch: 1 },
        messages: fileAsk,
      }),
    ).toBeNull();
  });

  it('a turn without a client is never coordinated', () => {
    expect(meriDocumentRequestFor({ messages: fileAsk })).toBeNull();
  });
});
