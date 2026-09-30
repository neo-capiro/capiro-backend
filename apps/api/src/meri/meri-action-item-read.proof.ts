import { createHash } from 'node:crypto';
import { researchJsonSha256 } from './meri-research-durable-result.js';

type UnknownRecord = Record<string, unknown>;
const SHA256_RE = /^[a-f0-9]{64}$/;
const record = (value: unknown): UnknownRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const finiteDate = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const jsonObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

function linkedSourceProofs(value: unknown): UnknownRecord[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const sources: UnknownRecord[] = [];
  for (const candidate of value) {
    const source = record(candidate);
    if (
      !source ||
      source.owner !== 'source_document' ||
      typeof source.sourceRecordId !== 'string' ||
      ids.has(source.sourceRecordId) ||
      !finiteDate(source.sourceVersion) ||
      !SHA256_RE.test(String(source.contentSha256))
    )
      return null;
    ids.add(source.sourceRecordId);
    sources.push(source);
  }
  return sources;
}

export function canonicalActionItemOwnerProof(value: unknown): string[] | null {
  const root = record(value);
  const scope = record(root?.scope);
  const coverage = record(root?.coverage);
  if (
    root?.tool !== 'query_action_items' ||
    typeof root.clientId !== 'string' ||
    !scope ||
    !coverage ||
    coverage.sourceStatus !== 'healthy' ||
    coverage.complete !== true ||
    coverage.partial !== false ||
    coverage.paginationComplete !== true ||
    coverage.hasMore !== false ||
    coverage.nextCursor !== null ||
    coverage.totalIsExactForScope !== true ||
    scope.page !== 1 ||
    scope.cursorApplied !== false ||
    !Number.isSafeInteger(root.total) ||
    !Number.isSafeInteger(root.returned) ||
    root.total !== root.returned ||
    !Array.isArray(root.actions) ||
    root.returned !== root.actions.length
  )
    return null;
  const ids = new Set<string>();
  const projected = [];
  for (const candidate of root.actions) {
    const row = record(candidate);
    const completion = record(row?.nativeCompletion);
    const source = record(row?.sourceProof);
    const linkedSources = linkedSourceProofs(source?.linkedSources);
    if (
      !row ||
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      row.clientId !== root.clientId ||
      typeof row.title !== 'string' ||
      typeof row.body !== 'string' ||
      typeof row.issueTitle !== 'string' ||
      typeof row.recommendedAction !== 'string' ||
      typeof row.whatChanged !== 'string' ||
      typeof row.whyItMatters !== 'string' ||
      typeof row.status !== 'string' ||
      !nullableString(row.ownerUserId) ||
      !(row.deadline === null || finiteDate(row.deadline)) ||
      !nullableString(row.deadlineSource) ||
      typeof row.actionType !== 'string' ||
      !nullableString(row.outcome) ||
      !Array.isArray(row.evidence) ||
      !Array.isArray(row.targetAudience) ||
      typeof row.priority !== 'number' ||
      !jsonObject(row.confidence) ||
      !nullableString(row.uncertainty) ||
      !nullableString(row.dismissalReason) ||
      !nullableString(row.suggestedArtifactType) ||
      !finiteDate(row.createdAt) ||
      !finiteDate(row.updatedAt) ||
      row.recordKind !== 'action_recommendation' ||
      row.recommendation !== true ||
      row.acceptedAsTask !== false ||
      !completion ||
      completion.completed !== false ||
      completion.establishesDeliveryOrAcceptance !== false ||
      source?.version !== 1 ||
      source.owner !== 'action_recommendation' ||
      source.sourceRecordId !== row.id ||
      source.currentClientId !== root.clientId ||
      source.sourceVersion !== row.updatedAt ||
      !SHA256_RE.test(String(source.contentSha256)) ||
      !linkedSources
    )
      return null;
    const canonical = {
      id: row.id,
      districtKey: row.districtKey ?? null,
      clientId: row.clientId,
      clientName: row.clientName ?? null,
      peCode: row.peCode,
      programId: row.programId,
      deltaId: row.deltaId,
      actionType: row.actionType,
      issueTitle: row.issueTitle,
      whatChanged: row.whatChanged,
      whyItMatters: row.whyItMatters,
      recommendedAction: row.recommendedAction,
      targetAudience: row.targetAudience,
      suggestedArtifactType: row.suggestedArtifactType,
      deadline: row.deadline,
      deadlineSource: row.deadlineSource,
      ownerUserId: row.ownerUserId,
      priority: row.priority,
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      evidence: row.evidence,
      status: row.status,
      dismissalReason: row.dismissalReason,
      outcome: row.outcome,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      title: row.title,
      body: row.body,
    };
    if (source.contentSha256 !== sha256(JSON.stringify(canonical))) return null;
    ids.add(row.id);
    projected.push({
      ...canonical,
      sourceProof: { ...source, linkedSources },
      nativeCompletion: completion,
    });
  }
  return [
    researchJsonSha256({
      owner: 'action_recommendation',
      clientId: root.clientId,
      scope,
      rows: projected,
    }),
  ];
}

export function canonicalActionItemReauthorizationInput(
  input: Record<string, unknown>,
  savedResult: unknown,
): Record<string, unknown> | null {
  if (!canonicalActionItemOwnerProof(savedResult)) return null;
  const root = record(savedResult)!;
  const scope = record(root.scope)!;
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : null;
  const actionItemId = typeof input.actionItemId === 'string' ? input.actionItemId.trim() : null;
  const status = typeof input.status === 'string' ? input.status.trim() : null;
  const sort = typeof input.sort === 'string' ? input.sort.trim() : 'deadline';
  if (
    clientId !== root.clientId ||
    actionItemId !== scope.actionItemId ||
    status !== scope.status ||
    sort !== scope.sort ||
    scope.cursorApplied !== false
  )
    return null;
  return input;
}
