/** Workspace document themes and brand marks. These are not newsletter assets. */
import {
  array,
  bool,
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
import type { WorkspaceBlueprintStatus } from './workspace-template-definition.js';

export interface WorkspaceThemeVersion {
  id: string;
  tenantId: string;
  themeId: string;
  version: number;
  status: WorkspaceBlueprintStatus;
  settings: Record<string, unknown>;
  settingsHash: string;
  createdById: string;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}
export interface WorkspaceTheme {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  versions: WorkspaceThemeVersion[];
}
export interface WorkspaceBrandAsset {
  id: string;
  tenantId: string;
  uploadedById: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Refreshed from the authorized attachment owner on each read; unavailable has no URL. */
  url: string | null;
  available: boolean;
  scanDisclosure: string | null;
}
export interface WorkspaceBrandAssetRegistration {
  attachmentId: string;
}
export interface WorkspaceBrandUpload {
  id: string;
  tenantId: string;
  s3Key: string;
  fileName: string;
  contentType: string;
  contentLength: number;
  downloadUrl: string;
  scanDisclosure: string | null;
}

const hash: Rule = (value, path) => {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) refuse(path);
};
const count: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse(path);
};
const versionRule = object({
  id: workspaceUuid,
  tenantId: workspaceUuid,
  themeId: workspaceUuid,
  version: revision,
  status: literal('draft', 'published', 'retired'),
  settings: object({}),
  settingsHash: hash,
  createdById: text,
  createdAt: timestamp,
  publishedAt: nullable(timestamp),
  retiredAt: nullable(timestamp),
});
const themeFields = {
  id: workspaceUuid,
  tenantId: workspaceUuid,
  slug: text,
  name: text,
  description: nullable(text),
  ownerId: text,
  createdAt: timestamp,
  updatedAt: timestamp,
};
function same(actual: Json, expected: Json, path: string): void {
  if (
    typeof actual !== 'string' ||
    typeof expected !== 'string' ||
    actual.toLowerCase() !== expected.toLowerCase()
  )
    refuse(path, 'identity_mismatch');
}
function themeVersions(value: Json, ordered: boolean): void {
  const theme = row(value, '$'),
    ids = new Set<string>();
  let prior = 0;
  (theme.versions as Json[]).forEach((value, index) => {
    const version = row(value, `$.versions.${index}`),
      id = (version.id as string).toLowerCase();
    same(version.themeId!, theme.id!, `$.versions.${index}.themeId`);
    same(version.tenantId!, theme.tenantId!, `$.versions.${index}.tenantId`);
    if (ids.has(id) || (ordered && (version.version as number) <= prior))
      refuse(`$.versions.${index}`);
    ids.add(id);
    prior = version.version as number;
  });
}
export function parseWorkspaceThemeList(value: unknown): ReceiveResult<WorkspaceTheme[]> {
  return receive(
    value,
    array(object({ ...themeFields, versions: array(versionRule, 1) })),
    (items) => {
      (items as Json[]).forEach((item) => themeVersions(item, false));
    },
  );
}
/** Omit themeId only for the initial POST; slug binds that new parent response. */
export function parseWorkspaceThemeDetail(
  value: unknown,
  expected: { themeId: string } | { slug: string },
): ReceiveResult<WorkspaceTheme> {
  return receive(value, object({ ...themeFields, versions: array(versionRule) }), (item) => {
    const identity = row(snapshot(expected), '$expected'),
      actual = row(item, '$');
    if (Object.hasOwn(identity, 'themeId')) {
      workspaceUuid(identity.themeId!, '$expected.themeId');
      same(actual.id!, identity.themeId!, '$.id');
    } else {
      text(identity.slug!, '$expected.slug');
      if (actual.slug !== identity.slug) refuse('$.slug', 'identity_mismatch');
    }
    themeVersions(item, true);
  });
}
export function parseWorkspaceThemeVersion(
  value: unknown,
  expected: { themeId: string; versionId?: string },
): ReceiveResult<WorkspaceThemeVersion> {
  return receive(value, versionRule, (item) => {
    const wanted = snapshot(expected);
    object({ themeId: workspaceUuid }, { versionId: workspaceUuid })(wanted, '$expected');
    const identity = row(wanted, '$expected'),
      actual = row(item, '$');
    same(actual.themeId!, identity.themeId!, '$.themeId');
    if (identity.versionId !== undefined) same(actual.id!, identity.versionId, '$.id');
  });
}
const readUrl: Rule = (value, path) => {
  text(value, path);
  try {
    const url = new URL(value as string);
    if (url.protocol !== 'https:' || url.username || url.password) refuse(path);
  } catch {
    refuse(path);
  }
};
const assetRule: Rule = (value, path) => {
  object({
    id: workspaceUuid,
    tenantId: workspaceUuid,
    uploadedById: text,
    objectKey: text,
    filename: text,
    mimeType: text,
    sizeBytes: count,
    createdAt: timestamp,
    url: nullable(readUrl),
    available: bool,
    scanDisclosure: nullable(text),
  })(value, path);
  const asset = row(value, path);
  if (asset.available !== (asset.url !== null)) refuse(`${path}.url`);
};
export function parseWorkspaceBrandUploadList(
  value: unknown,
): ReceiveResult<WorkspaceBrandUpload[]> {
  return receive(
    value,
    array(
      object({
        id: workspaceUuid,
        tenantId: workspaceUuid,
        s3Key: text,
        fileName: text,
        contentType: literal('image/png', 'image/jpeg', 'image/webp'),
        contentLength: revision,
        downloadUrl: readUrl,
        scanDisclosure: nullable(text),
      }),
    ),
  );
}
export function parseWorkspaceBrandAssetList(value: unknown): ReceiveResult<WorkspaceBrandAsset[]> {
  return receive(value, array(assetRule));
}
/** Registration echoes the exact confirmed attachment selected; it is not an upload receipt. */
export function parseWorkspaceBrandAssetRegistered(
  value: unknown,
  expected: WorkspaceBrandAssetRegistration,
): ReceiveResult<WorkspaceBrandAsset & WorkspaceBrandAssetRegistration> {
  return receive(
    value,
    (item, path) => {
      assetRule(item, path);
      object({ attachmentId: workspaceUuid })(item, path);
    },
    (item) => {
      const wanted = snapshot(expected);
      object({ attachmentId: workspaceUuid })(wanted, '$expected');
      same(row(item, '$').attachmentId!, row(wanted, '$expected').attachmentId!, '$.attachmentId');
      if (row(item, '$').available !== true) refuse('$.available');
    },
  );
}
export function parseWorkspaceBrandAssetDeleted(
  value: unknown,
  expected: { assetId: string },
): ReceiveResult<{ deleted: true; assetId: string }> {
  return receive(
    value,
    object({
      assetId: workspaceUuid,
      deleted: (v, p) => {
        if (v !== true) refuse(p);
      },
    }),
    (item) => {
      const wanted = snapshot(expected);
      object({ assetId: workspaceUuid })(wanted, '$expected');
      same(row(item, '$').assetId!, row(wanted, '$expected').assetId!, '$.assetId');
    },
  );
}
