import { Injectable, Logger } from '@nestjs/common';
import { isValidPeCode } from '../../program-element/jbook/jbook-extract.js';

/**
 * SAM.gov solicitation personnel extractor (Step 33).
 *
 * Pure parser over a SAM.gov Contract Opportunities record. Extracts the
 * Contracting Officer / Contract Specialist from the solicitation header
 * (pointOfContact), captures both the email DOMAIN (surfaced to everyone) and the
 * full email (PII — the read layer gates it to capiro_admin), and attempts PE
 * attribution from the description. Only header fields (intentionally public) are
 * used; no external enrichment.
 */

export interface SamPointOfContact {
  fullName?: string;
  title?: string;
  email?: string;
  type?: string; // 'primary' | 'secondary'
}

export interface SamOpportunity {
  noticeId?: string;
  title?: string;
  description?: string;
  fullParentPathName?: string; // org hierarchy, e.g. "DEPT OF DEFENSE.DEPT OF THE ARMY..."
  department?: string;
  pointOfContact?: SamPointOfContact[];
  uiLink?: string;
}

export interface SamPerson {
  fullName: string;
  title: string | null;
  role: string | null; // KO | COR/CS | OTHER (inferred from title)
  organization: string | null;
  emailDomain: string | null; // domain (shown to everyone)
  // Full solicitation-POC email (public header field). PII: the read layer only
  // exposes it to capiro_admin. Null when the record carries no usable email.
  email: string | null;
  pePrimary: string | null;
  peSecondary: string[];
  programOfRecord: string | null;
  sourceUrl: string;
  snippet: string;
}

const PE_IN_TEXT = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/gi;

export const SAM_SOURCE = 'sam_gov';
export const SAM_CONFIDENCE = 0.85;

/** Anonymize an email to its domain. Returns null if not a usable email/domain. */
export function emailToDomain(raw: string | null | undefined): string | null {
  const s = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  if (!s) return null;
  if (s.includes('@')) {
    const d = s.split('@')[1]?.trim();
    return d && d.includes('.') ? d : null;
  }
  return null; // not an email — do NOT guess
}

/** Normalize a full email (validate shape). Returns null if not a usable email. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '');
  // Minimal shape check: local@domain.tld — do NOT guess/repair.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

/** First+last name check. */
export function hasFirstAndLast(name: string): boolean {
  const cleaned = name.replace(/\b(Dr|Mr|Ms|Mrs|Hon)\.?\b/gi, '').trim();
  return cleaned.split(/\s+/).filter((p) => /[A-Za-z]/.test(p)).length >= 2;
}

/** Infer an acquisition role from a POC title. */
export function inferRole(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  // COR must be checked BEFORE KO — "contracting officer's representative" contains
  // "contracting officer".
  if (/contracting officer'?s?\s+representative|\bcor\b/.test(t)) return 'COR';
  if (/contract(ing)?\s+officer\b|\bko\b|\bko,/.test(t)) return 'KO';
  if (/contract\s+specialist|\bcs\b/.test(t)) return 'CS';
  return 'OTHER';
}

@Injectable()
export class SamPersonnelExtractorService {
  private readonly logger = new Logger(SamPersonnelExtractorService.name);

  /** Is this opportunity from DoD? (org path / department check). */
  isDod(opp: SamOpportunity): boolean {
    const hay = `${opp.fullParentPathName ?? ''} ${opp.department ?? ''}`.toUpperCase();
    return /DEPT OF DEFENSE|DEPARTMENT OF DEFENSE|\bDOD\b|DEPT OF THE (ARMY|NAVY|AIR FORCE)|DEFENSE/.test(
      hay,
    );
  }

  /** Extract KO/CS/COR persons from one solicitation. Domain-only email. */
  extract(opp: SamOpportunity, knownPeCodes: ReadonlySet<string>): SamPerson[] {
    const url = opp.uiLink ?? (opp.noticeId ? `https://sam.gov/opp/${opp.noticeId}/view` : '');
    const org =
      (opp.fullParentPathName ?? opp.department ?? '').split('.').pop()?.trim() ||
      opp.department ||
      null;
    const pes = this.matchPeCodes(opp.description ?? '', knownPeCodes);
    const snippet = (opp.description ?? opp.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 480);

    const out: SamPerson[] = [];
    for (const poc of opp.pointOfContact ?? []) {
      const fullName = (poc.fullName ?? '').trim();
      if (!fullName || !hasFirstAndLast(fullName)) continue;
      const title = (poc.title ?? '').trim() || null;
      out.push({
        fullName,
        title,
        role: inferRole(title),
        organization: org,
        emailDomain: emailToDomain(poc.email),
        email: normalizeEmail(poc.email), // full email — read layer gates to capiro_admin
        pePrimary: pes[0] ?? null,
        peSecondary: pes.slice(1),
        programOfRecord: opp.title ? opp.title.slice(0, 300) : null,
        sourceUrl: url,
        snippet,
      });
    }
    return out;
  }

  matchPeCodes(description: string, knownPeCodes: ReadonlySet<string>): string[] {
    const found = new Set<string>();
    const matches = (description ?? '').toUpperCase().match(PE_IN_TEXT);
    if (matches) {
      for (const raw of matches) {
        const code = raw.trim().toUpperCase();
        if (isValidPeCode(code) && knownPeCodes.has(code)) found.add(code);
      }
    }
    return Array.from(found);
  }
}
