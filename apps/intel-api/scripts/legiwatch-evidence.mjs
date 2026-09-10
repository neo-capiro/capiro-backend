import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const sha256 = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
const id = (value) => {
  if (value === null || value === undefined || String(value) === '')
    throw new Error('Missing source identity');
  return String(value);
};
const key = (...parts) => parts.map(id).join(':');
export const INVENTORIES = {
  folder: ['folders-all-210', 210],
  assignment: ['bill-folder-memberships-1928', 1928],
  report: ['saved-bill-reports-6', 6],
  alert: ['alerts-40', 40],
  bill_keyword: ['bill-keywords-190', 190],
  news_keyword: ['news-keywords-38', 38],
  user: ['users-13', 13],
  contact: ['contacts-complete-80', 80],
  mailing_list: ['mailing-lists-25', 25],
  list_membership: ['contact-mailing-list-memberships-51', 51],
  statute: ['statute-memberships-174', 174],
  committee_legislator: ['committee-legislator-memberships-2', 2],
  alert_target: ['alert-selected-targets', 255],
  alert_channel: ['alert-recipient-channel-matrix', 520],
  report_observation: ['report-bill-comments', 10],
};

export async function loadEvidence(root) {
  const base = resolve(root),
    manifest = JSON.parse(await readFile(resolve(base, 'PACKAGE-MANIFEST.json'), 'utf8'));
  for (const entry of manifest.files) {
    const path = resolve(base, entry.path);
    if (!path.startsWith(base + sep)) throw new Error('Manifest path leaves package');
    const bytes = await readFile(path);
    if (bytes.length !== entry.size_bytes || sha256(bytes) !== entry.sha256)
      throw new Error(`Evidence checksum mismatch: ${entry.path}`);
  }
  const inventory = {};
  for (const [kind, [name, count]] of Object.entries(INVENTORIES)) {
    inventory[kind] = JSON.parse(
      await readFile(resolve(base, 'LobbyTools-Client-Audit/inventories', name + '.json'), 'utf8'),
    );
    if (!Array.isArray(inventory[kind]) || inventory[kind].length !== count)
      throw new Error(`Inventory count mismatch: ${kind}`);
  }
  inventory.externalComments = JSON.parse(
    await readFile(
      resolve(base, 'LobbyTools-Client-Audit/inventories/folder-comments-2.json'),
      'utf8',
    ),
  );
  if (inventory.externalComments.length !== 2) throw new Error('External comment count mismatch');
  inventory.folderContents = JSON.parse(
    await readFile(
      resolve(base, 'LobbyTools-Client-Audit/inventories/folder-contents-210.json'),
      'utf8',
    ),
  );
  if (inventory.folderContents.length !== 210) throw new Error('Folder contents count mismatch');
  return { inventory, sourceHash: sha256(manifest), verifiedFiles: manifest.files.length };
}

/** Deterministic, lossless normalization. Captured source values remain in payload. */
export function normalizeEvidence(inventory, manifest) {
  if (
    !manifest.tenantId ||
    !manifest.sourceAccount ||
    !manifest.captureId ||
    !('sourceTimezone' in manifest) ||
    !manifest.userTargetTenantId
  )
    throw new Error('Explicit tenant/account/capture/timezone/user-target manifest required');
  const keys = {
    folder: (r) => id(r.folder_id),
    assignment: (r) => key(r.folder_id, r.session, r.bill_id),
    report: (r) => id(r.report_id),
    alert: (r) => id(r.audit_key),
    bill_keyword: (r) => id(r.id),
    news_keyword: (r) => sha256(id(r.url)),
    user: (r) => id(r.user_id),
    contact: (r) => id(r.contact_id),
    mailing_list: (r) => id(r.id),
    list_membership: (r) => key(r.contact_id, r.mailing_list_id),
    statute: (r) => key(r.folder_id, sha256([r.statute_url, r.statute_label])),
    committee_legislator: (r) => key(r.folder_id, r.type, sha256(r.url)),
    alert_target: (r) => key(r.alert_key, r.type, r.target_id),
    alert_channel: (r) => key(r.alert_key, r.user_id),
    report_observation: (r) => key(r.folder_id, r.session, r.bill_id),
  };
  const folders = new Map(inventory.folder.map((r) => [id(r.folder_id), r]));
  const result = [];
  for (const kind of Object.keys(INVENTORIES)) {
    const seen = new Set();
    for (const original of inventory[kind]) {
      const sourceId = keys[kind](original);
      if (seen.has(sourceId)) throw new Error(`Duplicate ${kind} source identity: ${sourceId}`);
      seen.add(sourceId);
      const payload = structuredClone(original);
      if (kind === 'report') {
        payload.captured_folder_counts = (payload.folder_ids ?? []).map((folderId) => {
          const captured = inventory.folderContents.find(
            (f) => f.folder_id === folderId && f.bill_session === payload.session,
          );
          if (!captured) throw new Error('Missing captured report folder/session coverage');
          return {
            folder_id: folderId,
            session: captured.bill_session,
            count: captured.bill_count,
          };
        });
      }
      if (kind === 'assignment') {
        if (!folders.has(payload.folder_id))
          throw new Error('Membership references missing source folder');
        const matches = inventory.externalComments.filter(
          (c) => c.folder_id === payload.folder_id && c.bill_id === payload.bill_id,
        );
        if (matches.some((c) => c.visibility !== 'External'))
          throw new Error('Unknown comment visibility');
        payload.external_comments = matches.map((c) => c.comment).join('\n');
        payload.external_comment_evidence = matches;
        payload.internal_comments = ''; // No internal comments export was captured.
        payload.folder_owner_source_id = folders.get(payload.folder_id).form_owner_id;
      }
      if (kind === 'alert') {
        const hasTargets = (payload.selected_targets?.length ?? 0) > 0,
          hasTopics = (payload.selected_topics?.length ?? 0) > 0;
        payload.needs_review = !hasTargets && !hasTopics;
        if (!(payload.email_recipients?.length || payload.notification_recipients?.length))
          payload.needs_review = true;
      }
      result.push({
        kind,
        sourceId,
        payload,
        ...(kind === 'user' && manifest.tenantId !== manifest.userTargetTenantId
          ? { excludedReason: 'USER_BELONGS_TO_DESIGNATED_RUBIN_TURNBULL_TENANT' }
          : {}),
      });
    }
  }
  return result;
}

export function reconciliationSummary(items) {
  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return {
    total: items.length,
    byKind,
    distinctSourceBills: new Set(
      items.filter((i) => i.kind === 'assignment').map((i) => i.payload.bill_id),
    ).size,
    activeFolders: items.filter((i) => i.kind === 'folder' && !i.payload.form_archived).length,
    archivedFolders: items.filter((i) => i.kind === 'folder' && i.payload.form_archived).length,
    readOnlyFolders: items.filter(
      (i) => i.kind === 'folder' && i.payload.other_user_access === 'read_only',
    ).length,
    excludedUsers: items.filter((i) => i.kind === 'user' && i.excludedReason).length,
  };
}
