import {
  canonicalize,
  computeActionFingerprint,
  RepoBackedApprovalStore,
  InMemoryApprovalRepo,
} from './action-approval';
import { PolicyApprovalGate, ApprovalPendingError } from './approval-gate';
import { ruleBasedCompliancePolicy } from './compliance-rules';
import type { MeriContext } from '../registry/types';

const ctx: MeriContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk_1',
  role: 'standard_user',
};

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('recurses into nested objects and arrays', () => {
    expect(canonicalize({ x: { c: 1, a: 2 }, y: [{ b: 1, a: 2 }] })).toBe(
      canonicalize({ y: [{ a: 2, b: 1 }], x: { a: 2, c: 1 } }),
    );
  });
  it('tolerates circular refs', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalize(o)).not.toThrow();
  });
});

describe('computeActionFingerprint', () => {
  it('is stable for the same action regardless of input key order', () => {
    const a = computeActionFingerprint('send_email', { to: 'x@y.com', subject: 's' }, ctx);
    const b = computeActionFingerprint('send_email', { subject: 's', to: 'x@y.com' }, ctx);
    expect(a).toBe(b);
  });

  it('changes when ANY field of the action changes (no replay against a mutated action)', () => {
    const base = computeActionFingerprint('send_email', { to: 'x@y.com' }, ctx);
    expect(computeActionFingerprint('send_email', { to: 'z@y.com' }, ctx)).not.toBe(base); // input
    expect(computeActionFingerprint('reply_email', { to: 'x@y.com' }, ctx)).not.toBe(base); // tool
    expect(
      computeActionFingerprint('send_email', { to: 'x@y.com' }, { ...ctx, tenantId: 't2' }),
    ).not.toBe(base); // tenant
    expect(
      computeActionFingerprint('send_email', { to: 'x@y.com' }, { ...ctx, userId: 'u2' }),
    ).not.toBe(base); // user
  });
});

describe('RepoBackedApprovalStore', () => {
  it('returns false until the exact action is approved, then true', async () => {
    const repo = new InMemoryApprovalRepo();
    const store = new RepoBackedApprovalStore(repo);
    const input = { to: 'x@y.com', subject: 's', body: 'b' };

    expect(await store.isApproved('send_email', input, ctx)).toBe(false);
    repo.approve('send_email', input, ctx);
    expect(await store.isApproved('send_email', input, ctx)).toBe(true);
  });

  it('an approval does not carry to a DIFFERENT action', async () => {
    const repo = new InMemoryApprovalRepo();
    const store = new RepoBackedApprovalStore(repo);
    repo.approve('send_email', { to: 'x@y.com' }, ctx);
    expect(await store.isApproved('send_email', { to: 'DIFFERENT@y.com' }, ctx)).toBe(false);
  });
});

describe('PolicyApprovalGate wired with the rule engine + repo store (end-to-end B1+B2+B3)', () => {
  it('WARN + unapproved → ApprovalPendingError (write held); after approval → passes', async () => {
    const repo = new InMemoryApprovalRepo();
    const gate = new PolicyApprovalGate(
      ruleBasedCompliancePolicy(),
      new RepoBackedApprovalStore(repo),
    );
    const input = { to: 'x@y.com', subject: 's', body: 'b' };

    await expect(gate.check('send_email', input, ctx)).rejects.toBeInstanceOf(ApprovalPendingError);

    repo.approve('send_email', input, ctx);
    await expect(gate.check('send_email', input, ctx)).resolves.toBeUndefined(); // now allowed
  });
});
