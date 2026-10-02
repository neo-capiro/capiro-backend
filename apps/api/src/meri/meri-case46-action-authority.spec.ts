import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_CASE46,
  MERI_GOVERNED_ARTIFACT_HEADER,
  MERI_CAPTURE_POLICY_HEADER,
  encodeMeriGovernedArtifactTransport,
} from '@capiro/meriv2-core';
import {
  admitCase46ProposalTransport,
  case46ProposalMarker,
  publicCase46ProposalPreview,
} from './meri-case46-action-authority.js';
import { case46BudgetTestFixture } from './meri-case46-provider-budget.spec-helper.js';

describe('distinct case46 proposal transport', () => {
  const prior = process.env.INTERNAL_SERVICE_SECRET;
  beforeAll(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'case46-unit-only-key';
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = prior;
  });
  function fixture() {
    const { p } = case46BudgetTestFixture();
    const ctx = {
      tenantId: p.tenantId,
      tenantSlug: p.tenantSlug,
      userId: p.actorUserId,
      clerkUserId: 'test',
      role: 'standard_user',
    } satisfies TenantContext;
    const request = {
      tool: 'create_word',
      surface: 'chat',
      conversationId: p.conversationId,
      input: {
        title: MERI_CASE46.title,
        format: 'txt',
        text: MERI_CASE46.text,
        conversationId: p.conversationId,
        clientId: p.clientId,
      },
    };
    const req = {
      headers: {
        [MERI_GOVERNED_ARTIFACT_HEADER]: encodeMeriGovernedArtifactTransport(
          p,
          'action_proposal',
          process.env.INTERNAL_SERVICE_SECRET,
        ),
      },
    } as unknown as Request;
    return { p, ctx, request, req };
  }
  it('accepts only the exact frozen tool input under its own action MAC purpose', () => {
    const { p, ctx, request, req } = fixture();
    expect(admitCase46ProposalTransport(ctx, req, request)).toEqual(p);
    expect(() =>
      admitCase46ProposalTransport(ctx, req, {
        ...request,
        input: { ...request.input, text: MERI_CASE46.text.trim() },
      }),
    ).toThrow();
    expect(() =>
      admitCase46ProposalTransport(ctx, req, { ...request, tool: 'send_email' }),
    ).toThrow();
  });
  it('rejects mixed capability headers, wrong actor and wrong transport purpose', () => {
    const { p, ctx, request, req } = fixture();
    expect(() =>
      admitCase46ProposalTransport(
        ctx,
        { headers: { ...req.headers, [MERI_CAPTURE_POLICY_HEADER]: 'other' } } as unknown as Request,
        request,
      ),
    ).toThrow();
    expect(() =>
      admitCase46ProposalTransport({ ...ctx, userId: p.clientId }, req, request),
    ).toThrow();
    req.headers[MERI_GOVERNED_ARTIFACT_HEADER] = encodeMeriGovernedArtifactTransport(
      p,
      'provider_budget',
      process.env.INTERNAL_SERVICE_SECRET,
    );
    expect(() => admitCase46ProposalTransport(ctx, req, request)).toThrow();
  });
  it('absence is ordinary admission, not a synthetic capability inferred from the body', () => {
    const { ctx, request } = fixture();
    expect(admitCase46ProposalTransport(ctx, { headers: {} } as unknown as Request, request)).toBeNull();
  });
  it('does not expose private policy/turn binding in ordinary approval preview', () => {
    const { p } = fixture();
    expect(
      publicCase46ProposalPreview({
        label: 'Create file',
        governedArtifactCapture: case46ProposalMarker(p),
      }),
    ).toEqual({ label: 'Create file' });
  });
});
