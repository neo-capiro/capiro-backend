/**
 * Step 0.1 — backfill linker: decide which SourceDocument a pre-existing provenance row
 * belongs to. Pure + unit-tested; backfill-source-documents.ts builds the candidate index
 * (docs grouped by sourceUrl) and applies the decision via updateMany.
 *
 * Why this is not "match by sourceUrl" alone: one source PDF (one sourceUrl) yields several
 * artifacts/documents — e.g. the DARPA RDT&E master book backs BOTH a `r2` document and a
 * `r3` (performers) document at the SAME sourceUrl. program_element_source rows from that
 * PDF carry the same sourceUrl and differ only by exhibitType (R-2/R-2A vs R-3), so we
 * disambiguate by exhibitType -> documentType.
 */

/** Map a program_element_source.exhibitType (e.g. 'R-2A') to a SourceDocument.documentType. */
export function exhibitToDocumentType(exhibitType: string | null | undefined): string | null {
  const e = (exhibitType ?? '').toUpperCase().replace(/\s+/g, '');
  if (e === 'R-1' || e === 'R1') return 'r1';
  if (e === 'R-2' || e === 'R2' || e === 'R-2A' || e === 'R2A' || e === 'R-2B' || e === 'R2B') return 'r2';
  if (e === 'R-3' || e === 'R3') return 'r3';
  if (e === 'P-1' || e === 'P1') return 'p1';
  if (e === 'P-40' || e === 'P40') return 'p40';
  return null;
}

export interface LinkCandidate {
  id: string;
  documentType: string;
  sourceUrl: string;
}

export interface UrlRowToLink {
  sourceUrl: string | null;
  /** From program_element_source rows. */
  exhibitType?: string | null;
  /** Explicit expected documentType for tables that imply it (project -> r2, performer -> r3). */
  expectedDocumentType?: string | null;
}

export interface LinkDecision {
  documentId: string | null;
  reason: string;
}

/**
 * Choose the SourceDocument for a URL-provenanced row. `candidatesForUrl` MUST already be
 * filtered to documents whose sourceUrl equals row.sourceUrl (the caller groups by URL).
 */
export function chooseDocumentForUrlRow(row: UrlRowToLink, candidatesForUrl: LinkCandidate[]): LinkDecision {
  if (!row.sourceUrl) return { documentId: null, reason: 'row has no sourceUrl' };
  if (candidatesForUrl.length === 0) return { documentId: null, reason: 'no document with matching sourceUrl' };

  const wantType = row.expectedDocumentType ?? exhibitToDocumentType(row.exhibitType);
  if (wantType) {
    const typed = candidatesForUrl.filter((c) => c.documentType === wantType);
    const chosen = [...typed].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (chosen) {
      const reason =
        typed.length === 1
          ? `matched sourceUrl + documentType=${wantType}`
          : `ambiguous sourceUrl + documentType=${wantType} (${typed.length} docs); chose lowest id`;
      return { documentId: chosen.id, reason };
    }
    // wantType known but no candidate of that type at this URL → fall through to url-only.
  }

  const lone = candidatesForUrl.length === 1 ? candidatesForUrl[0] : undefined;
  if (lone) {
    return { documentId: lone.id, reason: 'single document for sourceUrl' };
  }
  return {
    documentId: null,
    reason: `ambiguous sourceUrl (${candidatesForUrl.length} docs), no documentType match for exhibit ${row.exhibitType ?? '∅'}`,
  };
}
