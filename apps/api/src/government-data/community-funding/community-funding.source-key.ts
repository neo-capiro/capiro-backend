/**
 * Campaign on-disk / ingest-run source key for CPF/CDS documents.
 *
 * IMPORTANT: this is NOT the canonical request identity hash. It only
 * disambiguates *source documents* for checkpointing and local artifact dirs.
 *
 * Root cause (validated disposable campaign, 2026-08): title-only slugs
 * collided across genuinely distinct official documents that share generic
 * titles ("Posted Table", subcommittee name repeated on /download/ vs
 * /imo/media/doc/ URL variants). Colliding keys overwrote each other's
 * on-disk docDir and corrupted the per-document coverage ledger.
 *
 * Fix: append a stable short hash of the full official URL so two candidates
 * with the same title but different URLs never share a key. Canonical
 * identity/dedup is unaffected (hashed on parsed request fields, never this key).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export type CommunityFundingSourceKeyChamber = 'house' | 'senate';

export interface CommunityFundingSourceKeyInput {
  chamber: CommunityFundingSourceKeyChamber;
  fiscalYear: number;
  title: string | null | undefined;
  url: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function communityFundingCampaignSourceKey(
  input: CommunityFundingSourceKeyInput,
): string {
  let pathBase = 'table';
  try {
    pathBase = path.basename(new URL(input.url).pathname) || 'table';
  } catch {
    pathBase = 'table';
  }
  const slug = (input.title || pathBase)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  const urlSuffix = sha256Hex(input.url).slice(0, 8);
  return `${input.chamber}_fy${input.fiscalYear}_${slug || 'table'}_${urlSuffix}`;
}
