/**
 * Directory photo provenance + preserved additive overlay (Task 13).
 *
 * Member selected-photo precedence is source-backed:
 *   1. public directory photo
 *   2. public primary photo
 *   3. any public photo
 *   4. Capiro photo overlay — ONLY when explicitly marked manualOverride
 *   5. initials fallback (null)
 *
 * Staff photos are nullable: a real source photo or a preserved overlay photo, else
 * initials. A staffer is NEVER given the associated member's photo, and no headshot
 * is fabricated. The overlay is read-only for the pipeline — it is preserved, never
 * written, by the refresh job.
 */
export interface DirectoryPhotoOverlayEntry {
  url: string;
  source: string;
  sourceUrl: string | null;
  addedAt: string;
  addedBy: string;
  manualOverride: boolean;
}

export interface DirectoryPhotoOverlay {
  people: Record<string, DirectoryPhotoOverlayEntry>;
}

export type DirectoryPhotoSource = 'legistorm' | 'capiro_overlay' | null;

export interface ResolvedPhoto {
  url: string | null;
  source: DirectoryPhotoSource;
}

export interface DirectoryPhotoRecord {
  id: number | null;
  url: string;
  status: string | null;
  isPrimary: boolean;
  isDirectory: boolean;
  updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Every source photo, preserved with its metadata (not just the selected URL). */
export function memberPhotoRecords(rawPhotos: unknown): DirectoryPhotoRecord[] {
  if (!Array.isArray(rawPhotos)) return [];
  return rawPhotos.filter(isRecord).map((photo) => ({
    id: Number.isFinite(Number(photo.id)) ? Number(photo.id) : null,
    url: String(photo.url ?? ''),
    status: typeof photo.status === 'string' ? photo.status : null,
    isPrimary: photo.is_primary === true,
    isDirectory: photo.is_directory === true,
    updatedAt: typeof photo.updated_at === 'string' ? photo.updated_at : null,
  }));
}

/** Deterministic member photo selection with provenance. */
export function resolveMemberPhoto(
  rawPhotos: unknown,
  overlay?: DirectoryPhotoOverlayEntry | null,
): ResolvedPhoto {
  const photos = Array.isArray(rawPhotos) ? rawPhotos.filter(isRecord) : [];
  const isPublic = (p: Record<string, unknown>): boolean => p.status === 'public';
  const source =
    nonEmpty(photos.find((p) => isPublic(p) && p.is_directory === true)?.url) ??
    nonEmpty(photos.find((p) => isPublic(p) && p.is_primary === true)?.url) ??
    nonEmpty(photos.find((p) => isPublic(p))?.url);
  if (source) return { url: source, source: 'legistorm' };
  // Overlay is only honored when explicitly a manual override.
  if (overlay?.manualOverride && nonEmpty(overlay.url)) {
    return { url: overlay.url, source: 'capiro_overlay' };
  }
  return { url: null, source: null };
}

/**
 * Staff photo: a real source photo (nullable — the current entitlement returns
 * none), else a preserved overlay photo, else null. Never a member substitute.
 */
export function resolveStaffPhoto(
  sourcePhotoUrl: unknown,
  overlay?: DirectoryPhotoOverlayEntry | null,
): ResolvedPhoto {
  const source = nonEmpty(sourcePhotoUrl);
  if (source) return { url: source, source: 'legistorm' };
  if (overlay && nonEmpty(overlay.url)) return { url: overlay.url, source: 'capiro_overlay' };
  return { url: null, source: null };
}

/** Defensive parse of the overlay JSON; unknown shapes yield an empty overlay. */
export function parsePhotoOverlay(raw: unknown): DirectoryPhotoOverlay {
  const people: Record<string, DirectoryPhotoOverlayEntry> = {};
  if (isRecord(raw) && isRecord(raw.people)) {
    for (const [personId, entry] of Object.entries(raw.people)) {
      if (!isRecord(entry) || typeof entry.url !== 'string') continue;
      people[personId] = {
        url: entry.url,
        source: typeof entry.source === 'string' ? entry.source : 'capiro_overlay',
        sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : null,
        addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
        addedBy: typeof entry.addedBy === 'string' ? entry.addedBy : '',
        manualOverride: entry.manualOverride === true,
      };
    }
  }
  return { people };
}
