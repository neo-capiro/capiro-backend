/** Current owned-image management replies. Parsing never performs or recovers a write. */
import {
  array,
  object,
  receive,
  refuse,
  row,
  snapshot,
  workspaceUuid,
  type Json,
  type ReceiveResult,
  type Rule,
} from './json-receiving.js';
import {
  parseNewsletterAssetDetails,
  parseNewsletterAssetItem,
  parseNewsletterAssetList,
  type NewsletterAssetDetails,
  type NewsletterAssetItem,
  type NewsletterAssetList,
} from './newsletter-receiving.js';

export interface NewsletterAssetFolder {
  id: string;
  name: string;
}
/** The service returns one unpaged collection, with no total or snapshot metadata. */
export interface NewsletterAssetFolders {
  items: NewsletterAssetFolder[];
}
/** No requested/root ID is echoed. The caller must retain the request and scope lifetime. */
export interface NewsletterAssetRevisionPage extends Omit<NewsletterAssetList, 'items'> {
  items: NewsletterAssetDetails[];
}
/** Folder deletion unfiles its assets; this flag echoes no folder or request identity. */
export interface NewsletterAssetFolderDeletion {
  deleted: true;
}
/** Count of distinct selected images, not their IDs or a final folder read. */
export interface NewsletterAssetsMoved {
  moved: number;
}
/** Count of distinct selected IDs, not all affected revisions or revoked public URLs. */
export interface NewsletterAssetsDeleted {
  deleted: number;
}

function exact(fields: Record<string, Rule>): Rule {
  return (value, path) => {
    object(fields)(value, path);
    for (const key of Object.keys(row(value, path)))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`${path}.${key}`);
  };
}
const folder = exact({
  id: workspaceUuid,
  name: (value, path) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 100) refuse(path);
  },
});
const selectedCount: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100)
    refuse(path);
};
function admit<T>(result: ReceiveResult<T>, path: string): T {
  if (!result.ok) refuse(path + result.error.path.slice(1), result.error.code);
  return result.value;
}
function bindId(value: Json, expected: unknown, key: 'assetId' | 'folderId') {
  const binding = row(snapshot(expected), '$expected');
  exact({ [key]: workspaceUuid })(binding, '$expected');
  if ((row(value, '$').id as string).toLowerCase() !== (binding[key] as string).toLowerCase())
    refuse('$.id', 'identity_mismatch');
}

/** Create returns only this folder. It does not echo the optional moved asset selection. */
export function parseNewsletterAssetFolder(value: unknown): ReceiveResult<NewsletterAssetFolder> {
  return receive(value, folder);
}
export function parseNewsletterAssetFolders(value: unknown): ReceiveResult<NewsletterAssetFolders> {
  // The array limit belongs to the shared JSON budget, not a service paging/completeness claim.
  return receive(value, exact({ items: array(folder) }));
}
export function parseNewsletterAssetFolderRename(
  value: unknown,
  expected: { folderId: string },
): ReceiveResult<NewsletterAssetFolder> {
  return receive(value, folder, (value) => bindId(value, expected, 'folderId'));
}
/** No identity is echoed; only a valid response to the caller's live request acknowledges it. */
export function parseNewsletterAssetFolderDeletion(
  value: unknown,
): ReceiveResult<NewsletterAssetFolderDeletion> {
  return receive(
    value,
    exact({
      deleted: (value, path) => {
        if (value !== true) refuse(path);
      },
    }),
  );
}
export function parseNewsletterAssetRename(
  value: unknown,
  expected: { assetId: string },
): ReceiveResult<NewsletterAssetItem> {
  return receive(
    value,
    (value, path) => {
      admit(parseNewsletterAssetItem(value), path);
    },
    (value) => bindId(value, expected, 'assetId'),
  );
}

/**
 * Each row has the existing detail shape, but the page never echoes the requested/root ID.
 * Passing a row's own ID to the existing parser validates its content only; it establishes
 * no relationship to the request, root, other rows or current selection. No expected-ID
 * parameter is offered here because the producer supplies no evidence to check it against.
 */
export function parseNewsletterAssetRevisionPage(
  value: unknown,
): ReceiveResult<NewsletterAssetRevisionPage> {
  return receive(value, (value, path) => {
    const page = row(value, path);
    const envelope = admit(parseNewsletterAssetList({ ...page, items: [] }), path);
    array((value, path) => {
      const item = row(value, path);
      if (typeof item.id !== 'string') refuse(`${path}.id`);
      admit(parseNewsletterAssetDetails(item, { assetId: item.id }), path);
    }, envelope.pageSize)(page.items!, `${path}.items`);
  });
}
/** No selected IDs or destination are echoed; a refreshed list cannot recover a lost reply. */
export function parseNewsletterAssetsMoved(value: unknown): ReceiveResult<NewsletterAssetsMoved> {
  return receive(value, exact({ moved: selectedCount }));
}
/** The service soft-deletes revision families; public capability bytes remain retrievable. */
export function parseNewsletterAssetsDeleted(
  value: unknown,
): ReceiveResult<NewsletterAssetsDeleted> {
  return receive(value, exact({ deleted: selectedCount }));
}
// Import returns the existing NewsletterAssetItem: use parseNewsletterAssetItem directly.
// It echoes neither the source URL nor folder ID, and is not an idempotent request receipt.
