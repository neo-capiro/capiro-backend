#!/usr/bin/env tsx
/**
 * Pure request materializer for the Phase 3 full-read parity sweep.
 *
 * The generated web inventory stores `:param` because it describes concrete
 * browser consumers, while the accepted API manifest keeps named parameters.
 * Read parity must recover those names, bind them to deterministic fixtures,
 * and add any query parameters required to exercise a real product state.
 *
 * A route may use a declared absence only when the Phase 3 fixture contract
 * deliberately forbids a row. The current example is async Outreach jobs:
 * Stage 3.7 requires `no job` while external generation is denied, so the GET
 * route is proved with one explicit deterministic 404 rather than pretending a
 * matching accidental 404 is successful data parity.
 */

export interface Phase3ReadInventoryRequest {
  method: string;
  requestPath: string;
  routeManifestKey: string;
  classification: 'read' | 'safe_local_write' | 'external_action';
  surface: string;
}

export interface Phase3FixtureIndex {
  ids: Record<string, string>;
}

export type Phase3ReadExpectation =
  | { kind: 'data'; allowedStatuses: readonly number[] }
  | { kind: 'declared_absence'; allowedStatuses: readonly number[]; reason: string };

export interface MaterializedPhase3Read {
  relative: string;
  expectation: Phase3ReadExpectation;
  bindings: Record<string, string>;
}

const DATA_2XX: Phase3ReadExpectation = {
  kind: 'data',
  allowedStatuses: Array.from({ length: 100 }, (_, index) => 200 + index),
};

const JOB_ABSENCE_REASON =
  'Stage 3.7 requires no Outreach job while generation is denied; the fixture contract ' +
  'therefore proves this feature-gated read with one explicit deterministic absence.';

function requiredFixture(ids: Record<string, string>, key: string): string {
  const value = ids[key];
  if (!value) throw new Error(`Phase 3 fixture index is missing ${key}`);
  return value;
}

function parseManifestKey(routeManifestKey: string): { method: string; pathname: string } {
  const space = routeManifestKey.indexOf(' ');
  if (space <= 0) throw new Error(`Invalid route manifest key: ${routeManifestKey}`);
  return {
    method: routeManifestKey.slice(0, space),
    pathname: routeManifestKey.slice(space + 1),
  };
}

function genericPath(pathname: string): string {
  return pathname.replace(/:[A-Za-z0-9_]+/g, ':param');
}

function fixtureKeyForParameter(pathname: string, parameter: string): string {
  switch (parameter) {
    case 'clientId':
      return 'client.alpha';
    case 'meetingId':
      return 'meeting.past';
    case 'outreachRecordId':
      // This record owns artifact.sent, so the nested list is populated.
      return 'outreach.sent';
    case 'versionId':
    case 'candidateVersionId':
      return 'version.sentV2';
    case 'artifactId':
      return 'artifact.sent';
    case 'noteId':
      return 'note.adminDraft';
    case 'debriefId':
      return 'debrief.approved';
    case 'attachmentId':
      return 'attachment.meetingReady';
    case 'itemId':
      throw new Error(
        `${pathname} requires an Outreach job item, but Phase 3 deliberately seeds no job/item`,
      );
    case 'connectionId':
      if (pathname.includes('/integrations/google/')) return 'connection.googleConnected';
      return 'connection.microsoftConnected';
    case 'id':
      if (/\/meetings\/:id(?:\/|$)/.test(pathname)) return 'meeting.past';
      if (/\/meeting-preps\/:id(?:\/|$)/.test(pathname)) return 'prep.approved.1';
      if (/\/attachments\/:id(?:\/|$)/.test(pathname)) return 'attachment.meetingReady';
      if (/\/outreach\/jobs\/:id(?:\/|$)/.test(pathname)) return 'absent.outreachRecord';
      if (/\/outreach\/send-intents\/:id(?:\/|$)/.test(pathname)) {
        return 'sendIntent.deliveryUnknown';
      }
      if (/\/outreach\/ai-templates\/:id(?:\/|$)/.test(pathname)) return 'aiTemplate.general';
      if (/\/outreach\/:id(?:\/|$)/.test(pathname)) return 'outreach.draft';
      if (/\/tasks\/:id(?:\/|$)/.test(pathname)) return 'task.todo.1';
      throw new Error(`No Phase 3 fixture binding for :id in ${pathname}`);
    default:
      throw new Error(`No Phase 3 fixture binding for :${parameter} in ${pathname}`);
  }
}

function queryForRoute(routeManifestKey: string, ids: Record<string, string>): string {
  const params = new URLSearchParams();
  switch (routeManifestKey) {
    case 'GET /api/engagement/attachments':
      // The endpoint rejects an unqualified list: one parent or unlinked=true is required.
      params.set('meetingId', requiredFixture(ids, 'meeting.past'));
      break;
    case 'GET /api/engagement/contacts':
      params.set('limit', '20');
      break;
    case 'GET /api/engagement/mail-threads':
    case 'GET /api/engagement/meetings':
    case 'GET /api/engagement/tasks':
      params.set('clientId', requiredFixture(ids, 'client.alpha'));
      break;
    case 'GET /api/engagement/meetings/library':
      params.set('clientId', requiredFixture(ids, 'client.alpha'));
      params.set('limit', '20');
      break;
    case 'GET /api/engagement/shared-meetings':
      params.set('clientId', requiredFixture(ids, 'client.alpha'));
      break;
    case 'GET /api/engagement/outreach/audiences':
      params.set('kind', 'list');
      break;
    case 'GET /api/engagement/outreach/insights':
    case 'GET /api/engagement/outreach/outbound/contact-data':
      params.set('clientId', requiredFixture(ids, 'client.alpha'));
      break;
    case 'GET /api/engagement/reports/overview':
      params.set('period', 'current');
      params.set('clientId', requiredFixture(ids, 'client.alpha'));
      break;
    default:
      break;
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function materializePhase3Read(
  request: Phase3ReadInventoryRequest,
  fixtureIndex: Phase3FixtureIndex,
): MaterializedPhase3Read {
  if (request.classification !== 'read') {
    throw new Error(`Cannot materialize non-read request ${request.routeManifestKey}`);
  }
  const manifest = parseManifestKey(request.routeManifestKey);
  if (manifest.method !== request.method) {
    throw new Error(
      `${request.routeManifestKey} disagrees with inventory method ${request.method}`,
    );
  }
  if (genericPath(manifest.pathname) !== request.requestPath) {
    throw new Error(
      `${request.routeManifestKey} does not structurally match ${request.requestPath}`,
    );
  }

  const bindings: Record<string, string> = {};
  const pathname = manifest.pathname.replace(/:([A-Za-z0-9_]+)/g, (_match, parameter: string) => {
    const key = fixtureKeyForParameter(manifest.pathname, parameter);
    const value = requiredFixture(fixtureIndex.ids, key);
    bindings[parameter] = key;
    return encodeURIComponent(value);
  });

  const declaredJobAbsence = request.routeManifestKey === 'GET /api/engagement/outreach/jobs/:id';
  return {
    relative: `${pathname}${queryForRoute(request.routeManifestKey, fixtureIndex.ids)}`,
    expectation: declaredJobAbsence
      ? { kind: 'declared_absence', allowedStatuses: [404], reason: JOB_ABSENCE_REASON }
      : DATA_2XX,
    bindings,
  };
}

export function uniquePhase3Reads(
  requests: readonly Phase3ReadInventoryRequest[],
): Phase3ReadInventoryRequest[] {
  const unique = new Map<string, Phase3ReadInventoryRequest>();
  for (const request of requests) {
    if (request.classification !== 'read') continue;
    const key = `${request.method} ${request.requestPath}`;
    const existing = unique.get(key);
    if (existing && existing.routeManifestKey !== request.routeManifestKey) {
      throw new Error(
        `Ambiguous Phase 3 read inventory for ${key}: ` +
          `${existing.routeManifestKey} vs ${request.routeManifestKey}`,
      );
    }
    unique.set(key, request);
  }
  return [...unique.values()];
}

export const PHASE3_JOB_READ_ABSENCE_REASON = JOB_ABSENCE_REASON;
