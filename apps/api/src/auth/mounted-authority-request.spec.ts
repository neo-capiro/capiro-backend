import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import { isMeriExecutionCapabilityPost, isMeriRoutineUnattendedGrantPost } from './meri-execution-request.js';
import { isMeriReadDelegationServicePost } from './read-delegation/read-delegation-request.js';
import {
  isSignedMemoryHelperPost, isSignedMemoryPagePost, isSignedMemoryProposalPost,
} from './read-delegation/signed-memory-http-gate.js';
import { coreRosterPreviewDecision, isPreviewNativeReadRoute } from './preview-native-read-mode.js';

const executionBearer = `Bearer ${Buffer.from(JSON.stringify({ typ: 'capiro-meri-execution+jwt' })).toString('base64url')}.payload.signature`;
const delegationId = '11111111-1111-4111-8111-111111111111';
const cases: Array<{ path: string; test: (req: Request) => boolean; authorization?: string }> = [
  { path: '/api/clio/tools/create_task', test: isMeriExecutionCapabilityPost, authorization: executionBearer },
  { path: '/api/clio/routines/unattended-grant', test: isMeriRoutineUnattendedGrantPost },
  { path: '/api/clio/application-authority/read-delegations', test: isMeriReadDelegationServicePost },
  { path: `/api/clio/application-authority/read-delegations/${delegationId}/tokens`, test: isMeriReadDelegationServicePost },
  { path: `/api/clio/application-authority/read-delegations/${delegationId}/revocations`, test: isMeriReadDelegationServicePost },
  { path: `/api/clio/application-authority/read-delegation-consents/${delegationId}/state`, test: isMeriReadDelegationServicePost },
  { path: '/api/clio/tools/search_memory_eligibility', test: isSignedMemoryHelperPost },
  { path: '/api/clio/tools/search_memory', test: isSignedMemoryPagePost },
  { path: '/api/clio/tools/memory.list_own_proposals', test: isSignedMemoryProposalPost },
];

function mounted(path: string, authorization?: string): Request {
  return { method: 'POST', baseUrl: path, path: '/', url: '/', originalUrl: path,
    headers: authorization ? { authorization } : {} } as Request;
}

describe('mounted exact authority predicates', () => {
  it.each(cases)('admits only the original exact mounted target $path', ({ path, test, authorization }) => {
    expect(test(mounted(path, authorization))).toBe(true);
    expect(test({ ...mounted(path, authorization), baseUrl: '/api', path: path.slice(4) } as Request)).toBe(true);
    expect(test({ ...mounted(path, authorization), baseUrl: '', path } as Request)).toBe(true);
    for (const req of [
      { ...mounted(path, authorization), method: 'GET' },
      { ...mounted(path, authorization), originalUrl: `${path}?q=1` },
      { ...mounted(path, authorization), originalUrl: `${path}#fragment` },
      { ...mounted(path, authorization), originalUrl: `http://core.invalid${path}` },
      { ...mounted(path, authorization), originalUrl: '/rewritten' },
      mounted(`${path}/`, authorization),
      mounted(`${path}-other`, authorization),
    ]) expect(test(req as Request)).toBe(false);
  });

  it('keeps bearer-less service routes separate from arbitrary credentials', () => {
    expect(isMeriRoutineUnattendedGrantPost(mounted('/api/clio/routines/unattended-grant', 'Bearer native'))).toBe(false);
    expect(isMeriReadDelegationServicePost(mounted('/api/clio/application-authority/read-delegations', 'Bearer native'))).toBe(false);
    expect(isMeriExecutionCapabilityPost(mounted('/api/clio/tools/create_task', 'Bearer native'))).toBe(false);
  });

  it('uses the mounted roster path without changing its host and query restrictions', () => {
    const req = { ...mounted('/api/clients'), method: 'GET',
      headers: { host: 'core-roster-preview.capiro.ai' },
      rawHeaders: ['Host', 'core-roster-preview.capiro.ai'] } as Request;
    expect(coreRosterPreviewDecision(req, true, true)).toBe('preview');
    expect(coreRosterPreviewDecision({ ...req, originalUrl: '/api/clients?sectorTag=defense' } as Request, true, true)).toBe('preview');
    for (const originalUrl of ['/api/clients/', '/api/clients?unknown=x', '/api/clients#fragment',
      'http://core-roster-preview.capiro.ai/api/clients', '/api/me']) {
      expect(coreRosterPreviewDecision({ ...req, originalUrl } as Request, true, true)).toBe('not-found');
    }
  });

  it('keeps preview protection active for malformed targets that Express can route', () => {
    const req = { ...mounted('/api/memory/owner/items'), method: 'GET' } as Request;
    expect(isPreviewNativeReadRoute(req)).toBe(true);
    expect(isPreviewNativeReadRoute({ ...req, originalUrl: 'http://core.invalid/api/memory/owner/items' } as Request)).toBe(true);
    expect(isPreviewNativeReadRoute({ ...req, baseUrl: '/api/memory/owner/items/', originalUrl: '/api/memory/owner/items/' } as Request)).toBe(true);
    expect(isPreviewNativeReadRoute({ ...req, method: 'HEAD' } as Request)).toBe(true);
    expect(isPreviewNativeReadRoute({ ...req, method: 'POST' } as Request)).toBe(false);
  });
});
