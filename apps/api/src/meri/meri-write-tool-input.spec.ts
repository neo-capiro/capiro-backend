import { BadRequestException } from '@nestjs/common';
import { validateMeriWriteToolInput, type MeriJsonSchema } from './meri-write-tool-input.js';

const schema: MeriJsonSchema = {
  type: 'object',
  properties: {
    clientId: { type: 'string' },
    to: { type: 'string' },
    subject: { type: 'string', maxLength: 200 },
    body: { type: 'string' },
    recipients: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', additionalProperties: true },
  },
  required: ['clientId', 'to', 'body'],
};

const valid = {
  body: 'Hello',
  to: 'person@example.com',
  clientId: '11111111-1111-4111-8111-111111111111',
  subject: 'Subject',
};

describe('validateMeriWriteToolInput', () => {
  it('returns canonical plain JSON with object keys sorted and array order preserved', () => {
    const result = validateMeriWriteToolInput(
      'send_email',
      { ...valid, recipients: ['second@example.com', 'first@example.com'] },
      schema,
    );
    expect(Object.keys(result)).toEqual(['body', 'clientId', 'recipients', 'subject', 'to']);
    expect(result.recipients).toEqual(['second@example.com', 'first@example.com']);
  });

  it('rejects missing required values and unknown top-level fields', () => {
    expect(() => validateMeriWriteToolInput('send_email', { to: valid.to }, schema)).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateMeriWriteToolInput('send_email', { ...valid, surprise: true }, schema),
    ).toThrow(/not an allowed property/);
  });

  it.each(['tenantId', 'userId', 'fingerprint', 'policyDecision', 'proposalId'])(
    'rejects model-injected authority field %s even inside free-form metadata',
    (field) => {
      expect(() =>
        validateMeriWriteToolInput(
          'send_email',
          { ...valid, metadata: { nested: { [field]: 'attacker-controlled' } } },
          schema,
        ),
      ).toThrow(/controlled by the server/);
    },
  );

  it('enforces UUID and email validation at the shared proposal/execution parser', () => {
    expect(() => validateMeriWriteToolInput('send_email', { ...valid, clientId: 'Acme' }, schema)).toThrow(
      /must be a UUID/,
    );
    expect(() => validateMeriWriteToolInput('send_email', { ...valid, to: 'not-an-email' }, schema)).toThrow(
      /valid email/,
    );
  });

  it('rejects oversized arrays, payloads, and circular references', () => {
    expect(() =>
      validateMeriWriteToolInput(
        'send_email',
        { ...valid, recipients: Array.from({ length: 101 }, () => 'x@example.com') },
        schema,
      ),
    ).toThrow(/at most 100/);
    expect(() => validateMeriWriteToolInput('send_email', { ...valid, body: 'x'.repeat(70_000) }, schema)).toThrow();
    const circular: Record<string, unknown> = { ...valid, metadata: {} };
    (circular.metadata as Record<string, unknown>).self = circular.metadata;
    expect(() => validateMeriWriteToolInput('send_email', circular, schema)).toThrow(/circular/);
  });
});
