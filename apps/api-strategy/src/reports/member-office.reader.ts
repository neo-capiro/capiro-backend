import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { sniffRasterContentType } from "./client-logo.reader.js";
import { sanitizeRasterAsset } from "./report-image.js";
import type {
  ReportMemberDetail,
  ReportMemberOfficeAddress,
  ReportMemberProfile,
  ReportRasterAsset,
} from "./report.types.js";

export const MEMBER_OFFICE_READER = Symbol("MEMBER_OFFICE_READER");

export interface MemberOfficeReader {
  /** Resolve Directory detail for the referenced member offices. Fails soft per member. */
  resolve(input: {
    bearer: string | undefined;
    members: readonly ReportMemberProfile[];
  }): Promise<ReportMemberDetail[]>;
  /** Fetch and sanitize a member portrait from an allow-listed host. Fails soft. */
  photo(url: string): Promise<ReportRasterAsset | null>;
}

const DETAIL_TIMEOUT_MS = 6_000;
const PHOTO_TIMEOUT_MS = 6_000;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_LOOKUPS = 4;
const DETAIL_CACHE_MS = 30 * 60 * 1000;
const DETAIL_FAILURE_CACHE_MS = 2 * 60 * 1000;
const DETAIL_CACHE_ENTRIES = 256;
const PHOTO_CACHE_MS = 30 * 60 * 1000;
const PHOTO_CACHE_ENTRIES = 64;
const DEFAULT_PHOTO_HOSTS = "img.legistorm.com";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Member-office detail lives in the Directory (an S3-backed snapshot served by
 * apps/api), not in Postgres, so api-strategy hops to
 * `GET /api/directory/members/:id` under the CALLER's bearer — the same
 * pattern StrategyAttachmentResolver uses. Portrait bytes are fetched from the
 * Directory's photo host only (allow-listed, HTTPS, no redirects, size-capped,
 * magic-byte sniffed, metadata-stripped) before they may enter an OOXML
 * package. Everything here degrades to "no detail / no photo": a Directory
 * hiccup never blocks a report.
 */
@Injectable()
export class DirectoryMemberOfficeReader implements MemberOfficeReader {
  private readonly logger = new Logger(DirectoryMemberOfficeReader.name);
  private readonly apiBaseUrl: string;
  private readonly photoHosts: string[];
  private readonly detailCache = new Map<
    string,
    CacheEntry<ReportMemberDetail | null>
  >();
  private readonly photoCache = new Map<
    string,
    CacheEntry<ReportRasterAsset | null>
  >();

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>("API_INTERNAL_URL") ??
      config.get<string>("API_BASE_URL") ??
      "https://app.capiro.ai"
    ).replace(/\/+$/, "");
    this.photoHosts = (
      config.get<string>("REPORT_MEMBER_PHOTO_HOSTS") ?? DEFAULT_PHOTO_HOSTS
    )
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  }

  async resolve(input: {
    bearer: string | undefined;
    members: readonly ReportMemberProfile[];
  }): Promise<ReportMemberDetail[]> {
    const results: ReportMemberDetail[] = [];
    const queue = [...input.members];
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_LOOKUPS, queue.length) },
      async () => {
        for (;;) {
          const member = queue.shift();
          if (!member) return;
          results.push(await this.resolveOne(input.bearer, member));
        }
      },
    );
    await Promise.all(workers);
    // Preserve the snapshot's member order regardless of completion order.
    const byId = new Map(results.map((detail) => [detail.memberId, detail]));
    return input.members.map(
      (member) => byId.get(member.memberId) ?? fallbackDetail(member),
    );
  }

  private async resolveOne(
    bearer: string | undefined,
    member: ReportMemberProfile,
  ): Promise<ReportMemberDetail> {
    // Only the congressional directory exposes a Washington office. State
    // legislators keep their stored reference fields and no portrait.
    if ((member.sourceDirectory ?? "congress") !== "congress" || !bearer) {
      return fallbackDetail(member);
    }
    // Directory access is checked under this caller's bearer, and mapping can
    // fall back to this strategy's stored reference fields. Neither a success
    // nor an authorization failure may be reused for a different caller or
    // reference. Hash the key so credentials never remain in cache keys.
    const cacheKey = createHash("sha256")
      .update(JSON.stringify([bearer, member]))
      .digest("hex");
    const cached = this.detailCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value ?? fallbackDetail(member);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/directory/members/${encodeURIComponent(
          member.memberId,
        )}`,
        {
          headers: {
            accept: "application/json",
            authorization: bearer.startsWith("Bearer ")
              ? bearer
              : `Bearer ${bearer}`,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = mapMemberDetail(
        member,
        (await response.json()) as unknown,
        this.photoHosts,
      );
      this.cacheDetail(cacheKey, {
        value: detail,
        expiresAt: Date.now() + DETAIL_CACHE_MS,
      });
      return detail;
    } catch (error) {
      // Never log the member name; only that the lookup degraded.
      this.logger.warn(
        `Member office lookup unavailable during report export: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
      this.cacheDetail(cacheKey, {
        value: null,
        expiresAt: Date.now() + DETAIL_FAILURE_CACHE_MS,
      });
      return fallbackDetail(member);
    } finally {
      clearTimeout(timer);
    }
  }

  private cacheDetail(key: string, entry: CacheEntry<ReportMemberDetail | null>): void {
    if (this.detailCache.size >= DETAIL_CACHE_ENTRIES && !this.detailCache.has(key)) {
      const oldest = this.detailCache.keys().next().value;
      if (oldest !== undefined) this.detailCache.delete(oldest);
    }
    this.detailCache.set(key, entry);
  }

  async photo(url: string): Promise<ReportRasterAsset | null> {
    if (!isAllowedPhotoUrl(url, this.photoHosts)) return null;
    const cached = this.photoCache.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
    let asset: ReportRasterAsset | null = null;
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        // A redirect could leave the allow-listed host; refuse rather than follow.
        redirect: "error",
        headers: { accept: "image/png,image/jpeg" },
      });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (response.ok && declared <= MAX_PHOTO_BYTES && response.body) {
        // Content-Length may be absent or false. Bound the bytes while reading
        // so a chunked oversized response cannot exhaust the report process.
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_PHOTO_BYTES) {
              await reader.cancel();
              return null;
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks, size);
        const contentType = sniffRasterContentType(bytes);
        if (
          bytes.length > 0 &&
          bytes.length <= MAX_PHOTO_BYTES &&
          contentType
        ) {
          asset = sanitizeRasterAsset({ bytes, contentType });
        }
      } else {
        await response.body?.cancel();
      }
    } catch (error) {
      this.logger.warn(
        `Member portrait unavailable during report export: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (this.photoCache.size >= PHOTO_CACHE_ENTRIES) {
      const oldest = this.photoCache.keys().next().value;
      if (oldest !== undefined) this.photoCache.delete(oldest);
    }
    this.photoCache.set(url, {
      value: asset,
      expiresAt: Date.now() + PHOTO_CACHE_MS,
    });
    return asset;
  }
}

export function isAllowedPhotoUrl(
  value: string,
  allowedHosts: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    return false;
  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

export function fallbackDetail(member: ReportMemberProfile): ReportMemberDetail {
  return {
    memberId: member.memberId,
    name: member.name,
    party: member.party,
    state: member.state,
    chamber: member.chamber,
    district: null,
    committees: member.committee ? [member.committee] : [],
    washingtonOffice: null,
    photoUrl: null,
    photoSource: null,
    resolved: false,
  };
}

/**
 * Map the Directory member-detail payload onto the report contract. Every
 * field is read defensively: the payload is another service's contract and a
 * missing field must yield "unknown", never a thrown export.
 */
export function mapMemberDetail(
  member: ReportMemberProfile,
  payload: unknown,
  allowedPhotoHosts: readonly string[],
): ReportMemberDetail {
  const record = asRecord(payload);
  if (!record) return fallbackDetail(member);
  const identity = asRecord(record.identity) ?? {};
  const bio = asRecord(record.bioDetails) ?? {};
  const offices = asArray(record.offices).map(asRecord).filter(isRecord);
  const currentOffice =
    offices.find((office) => office.status === "current") ?? offices[0] ?? null;
  const firstName = text(identity.preferredFirstName) ?? text(identity.firstName);
  const lastName = text(identity.preferredLastName) ?? text(identity.lastName);
  const suffix = text(identity.suffix);
  const composedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = composedName
    ? suffix
      ? `${composedName}, ${suffix}`
      : composedName
    : member.name;

  // The Directory's committee memberships carry ids and positions, not names,
  // so the report keeps the committee the plan step itself recorded.
  const committees = member.committee ? [member.committee] : [];

  const addresses = asArray(record.officeAddresses)
    .map(asRecord)
    .filter(isRecord)
    .map(
      (entry): ReportMemberOfficeAddress & { isMain: boolean } => ({
        label: text(entry.label) ?? text(entry.officeName),
        address1: text(entry.address1),
        address2: text(entry.address2),
        city: text(entry.city),
        state: text(entry.state),
        zip: [text(entry.zip), text(entry.zipExt)].filter(Boolean).join("-") || null,
        phone: text(entry.phone),
        fax: text(entry.fax),
        isMain: entry.isMain === true,
      }),
    );

  const photoUrl = text(record.selectedPhotoUrl);
  return {
    memberId: member.memberId,
    name,
    party:
      text(bio.partyName) ??
      text(currentOffice?.party) ??
      member.party,
    state: text(currentOffice?.state) ?? member.state,
    chamber: chamberLabel(currentOffice, member.chamber),
    district: text(currentOffice?.district),
    committees,
    washingtonOffice: pickWashingtonOffice(addresses),
    photoUrl:
      photoUrl && isAllowedPhotoUrl(photoUrl, allowedPhotoHosts) ? photoUrl : null,
    photoSource: text(record.photoSource),
    resolved: true,
  };
}

/**
 * The Directory has no "DC office" flag: pick the Washington, DC address,
 * preferring the main office, then a Capitol-complex building, then any DC row.
 */
export function pickWashingtonOffice(
  addresses: ReadonlyArray<ReportMemberOfficeAddress & { isMain?: boolean }>,
): ReportMemberOfficeAddress | null {
  const dc = addresses.filter(
    (address) =>
      /^dc$/i.test(address.state ?? "") ||
      /^washington$/i.test(address.city ?? ""),
  );
  if (dc.length === 0) return null;
  const capitol = (address: ReportMemberOfficeAddress) =>
    /office building|capitol|longworth|rayburn|cannon|hart|dirksen|russell/i.test(
      `${address.address1 ?? ""} ${address.address2 ?? ""}`,
    );
  const chosen =
    dc.find((address) => address.isMain && capitol(address)) ??
    dc.find((address) => capitol(address)) ??
    dc.find((address) => address.isMain) ??
    dc[0]!;
  const { isMain: _isMain, ...office } = chosen;
  return office;
}

function chamberLabel(
  office: Record<string, unknown> | null,
  fallback: string | null,
): string | null {
  const typeId = text(office?.officeTypeId)?.toLowerCase() ?? "";
  const name = text(office?.name)?.toLowerCase() ?? "";
  if (/^(sen|senate|s)$/.test(typeId) || name.includes("senat")) return "Senate";
  if (/^(rep|house|h)$/.test(typeId) || name.includes("house")) return "House";
  if (!fallback) return null;
  if (/^sen/i.test(fallback)) return "Senate";
  if (/^(rep|house)/i.test(fallback)) return "House";
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
