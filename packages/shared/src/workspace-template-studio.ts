/** Read projections of TemplateStudioService HTTP metadata; never permissions or adoption receipts. */
import {
  array,
  literal,
  nullable,
  object,
  receive,
  refuse,
  revision,
  row,
  snapshot,
  text,
  timestamp,
  workspaceUuid,
  type Json,
  type ReceiveResult,
  type Rule,
} from './json-receiving.js';

export type WorkspaceBlueprintReadResult<T> = ReceiveResult<T>;
export type WorkspaceBlueprintStatus = 'draft' | 'published' | 'retired';
export interface WorkspaceBlueprintMetadata {
  id: string;
  tenantId: string | null;
  scope: 'capiro' | 'firm';
  slug: string;
  name: string;
  product: string;
  description: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Definition content is deliberately absent from this read-only projection. */
export interface WorkspaceBlueprintVersionMetadata {
  id: string;
  tenantId: string | null;
  blueprintId: string;
  version: number;
  status: WorkspaceBlueprintStatus;
  definitionHash: string;
  createdById: string;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}
export interface WorkspaceBlueprintListItem extends WorkspaceBlueprintMetadata {
  pinnedDocCount: number;
  /** Zero or one latest version, which may be draft or retired. Not latest-published. */
  versions: WorkspaceBlueprintVersionMetadata[];
}
export interface WorkspaceBlueprintDetail extends WorkspaceBlueprintMetadata {
  /** All versions in the producer's ascending numeric order. */
  versions: WorkspaceBlueprintVersionMetadata[];
}
export interface WorkspaceBlueprintCompareVersion {
  versionId: string;
  version: number;
  status: WorkspaceBlueprintStatus;
  definitionHash: string;
  createdAt: string;
  publishedAt: string | null;
}
export interface WorkspaceBlueprintComparison {
  blueprintId: string;
  versions: WorkspaceBlueprintCompareVersion[];
  /** Adjacent pairs only; changedKeys are top-level names, not content diffs. */
  diffs: { fromVersionId: string; toVersionId: string; changedKeys: string[] }[];
}
export interface WorkspaceBlueprintReadIdentity {
  blueprintId: string;
}
export interface WorkspaceBlueprintVersionReadIdentity extends WorkspaceBlueprintReadIdentity {
  versionId: string;
}

const hash: Rule = (value, path) => {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) refuse(path);
};
const count: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse(path);
};
const status = literal('draft', 'published', 'retired');
const metadataFields = {
  id: workspaceUuid,
  tenantId: nullable(workspaceUuid),
  scope: literal('capiro', 'firm'),
  slug: text,
  name: text,
  product: text,
  description: nullable(text),
  ownerId: nullable(text),
  createdAt: timestamp,
  updatedAt: timestamp,
};
const versionRule = object({
  id: workspaceUuid,
  tenantId: nullable(workspaceUuid),
  blueprintId: workspaceUuid,
  version: revision,
  status,
  definitionHash: hash,
  createdById: text,
  createdAt: timestamp,
  publishedAt: nullable(timestamp),
  retiredAt: nullable(timestamp),
});
const compareVersionRule = object({
  versionId: workspaceUuid,
  version: revision,
  status,
  definitionHash: hash,
  createdAt: timestamp,
  publishedAt: nullable(timestamp),
});
function sameId(actual: Json, expected: Json, path: string): void {
  if (
    typeof actual !== 'string' ||
    typeof expected !== 'string' ||
    actual.toLowerCase() !== expected.toLowerCase()
  )
    refuse(path, 'identity_mismatch');
}
function bind(
  value: Json,
  expected: unknown,
  blueprintKey: 'id' | 'blueprintId',
  version = false,
): void {
  const wanted = snapshot(expected);
  object({ blueprintId: workspaceUuid, ...(version ? { versionId: workspaceUuid } : {}) })(
    wanted,
    '$expected',
  );
  const identity = row(wanted, '$expected');
  const actual = row(value, '$');
  sameId(actual[blueprintKey]!, identity.blueprintId!, `$.${blueprintKey}`);
  if (version) sameId(actual.id!, identity.versionId!, '$.id');
}
function versionsBelong(value: Json, ordered: boolean): void {
  const blueprint = row(value, '$');
  const versions = blueprint.versions as Json[];
  let prior = 0;
  const ids = new Set<string>();
  versions.forEach((item, index) => {
    const version = row(item, `$.versions.${index}`);
    sameId(version.blueprintId!, blueprint.id!, `$.versions.${index}.blueprintId`);
    const id = (version.id as string).toLowerCase();
    if (ids.has(id) || (ordered && (version.version as number) <= prior))
      refuse(`$.versions.${index}`);
    ids.add(id);
    prior = version.version as number;
  });
}
function metadata(value: WorkspaceBlueprintMetadata): WorkspaceBlueprintMetadata {
  const { id, tenantId, scope, slug, name, product, description, ownerId, createdAt, updatedAt } =
    value;
  return { id, tenantId, scope, slug, name, product, description, ownerId, createdAt, updatedAt };
}
function versionMetadata(
  value: WorkspaceBlueprintVersionMetadata,
): WorkspaceBlueprintVersionMetadata {
  const {
    id,
    tenantId,
    blueprintId,
    version,
    status,
    definitionHash,
    createdById,
    createdAt,
    publishedAt,
    retiredAt,
  } = value;
  return {
    id,
    tenantId,
    blueprintId,
    version,
    status,
    definitionHash,
    createdById,
    createdAt,
    publishedAt,
    retiredAt,
  };
}
function compareMetadata(
  value: WorkspaceBlueprintCompareVersion,
): WorkspaceBlueprintCompareVersion {
  const { versionId, version, status, definitionHash, createdAt, publishedAt } = value;
  return { versionId, version, status, definitionHash, createdAt, publishedAt };
}

/** Actual unpaged catalog array. Missing/invalid input is not an empty catalog. */
export function parseWorkspaceBlueprintList(
  value: unknown,
): WorkspaceBlueprintReadResult<WorkspaceBlueprintListItem[]> {
  const result = receive<WorkspaceBlueprintListItem[]>(
    value,
    array(
      object({
        ...metadataFields,
        pinnedDocCount: count,
        versions: array(versionRule, 1),
      }),
    ),
    (rows) => (rows as Json[]).forEach((item) => versionsBelong(item, false)),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    value: result.value.map((item) => ({
      ...metadata(item),
      pinnedDocCount: item.pinnedDocCount,
      versions: item.versions.map(versionMetadata),
    })),
  };
}

/** Expectation must be captured from the requested blueprint, not taken from the response. */
export function parseWorkspaceBlueprintDetail(
  value: unknown,
  expected: WorkspaceBlueprintReadIdentity,
): WorkspaceBlueprintReadResult<WorkspaceBlueprintDetail> {
  const result = receive<WorkspaceBlueprintDetail>(
    value,
    object({ ...metadataFields, versions: array(versionRule) }),
    (item) => {
      bind(item, expected, 'id');
      versionsBelong(item, true);
    },
  );
  if (!result.ok) return result;
  return {
    ok: true,
    value: { ...metadata(result.value), versions: result.value.versions.map(versionMetadata) },
  };
}

export function parseWorkspaceBlueprintVersion(
  value: unknown,
  expected: WorkspaceBlueprintVersionReadIdentity,
): WorkspaceBlueprintReadResult<WorkspaceBlueprintVersionMetadata> {
  const result = receive<WorkspaceBlueprintVersionMetadata>(value, versionRule, (item) =>
    bind(item, expected, 'blueprintId', true),
  );
  return result.ok ? { ok: true, value: versionMetadata(result.value) } : result;
}

export function parseWorkspaceBlueprintCompare(
  value: unknown,
  expected: WorkspaceBlueprintReadIdentity,
): WorkspaceBlueprintReadResult<WorkspaceBlueprintComparison> {
  const result = receive<WorkspaceBlueprintComparison>(
    value,
    object({
      blueprintId: workspaceUuid,
      versions: array(compareVersionRule),
      diffs: array(
        object({
          fromVersionId: workspaceUuid,
          toVersionId: workspaceUuid,
          changedKeys: array(text),
        }),
      ),
    }),
    (item) => {
      bind(item, expected, 'blueprintId');
      const comparison = row(item, '$');
      const versions = comparison.versions as Json[];
      const diffs = comparison.diffs as Json[];
      if (diffs.length !== Math.max(0, versions.length - 1)) refuse('$.diffs');
      const ids = new Set<string>();
      let prior = 0;
      versions.forEach((item, index) => {
        const version = row(item, `$.versions.${index}`);
        const id = (version.versionId as string).toLowerCase();
        if (ids.has(id) || (version.version as number) <= prior) refuse(`$.versions.${index}`);
        ids.add(id);
        prior = version.version as number;
        if (index) {
          const diff = row(diffs[index - 1]!, `$.diffs.${index - 1}`);
          sameId(
            diff.fromVersionId!,
            row(versions[index - 1]!, '$').versionId!,
            `$.diffs.${index - 1}.fromVersionId`,
          );
          sameId(diff.toVersionId!, version.versionId!, `$.diffs.${index - 1}.toVersionId`);
        }
      });
    },
  );
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      blueprintId: result.value.blueprintId,
      versions: result.value.versions.map(compareMetadata),
      diffs: result.value.diffs.map(({ fromVersionId, toVersionId, changedKeys }) => ({
        fromVersionId,
        toVersionId,
        changedKeys,
      })),
    },
  };
}
