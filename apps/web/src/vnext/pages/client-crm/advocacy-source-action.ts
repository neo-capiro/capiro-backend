import { sourceUrl } from './client-fill-review-evidence.js';

interface SourceRecord {
  sourceType: string;
  sourceId: string | null;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Historical records can lack a URL even when their source identity is known. */
export function advocacySourceAction(record: SourceRecord) {
  const url = sourceUrl(record.sourceUrl) ?? sourceUrl(record.metadata?.sourceUrl);
  if (url) return { href: url, label: 'View source', guidance: null };

  if (record.sourceType === 'fara') {
    const registration = text(record.metadata?.registrationNumber) ?? text(record.sourceId);
    const registrant = text(record.metadata?.registrantName);
    const principal = text(record.metadata?.foreignPrincipal);
    const identity = [
      registration ? `Registrant number: ${registration}.` : null,
      registrant ? `Registrant: ${registrant}.` : null,
      principal ? `Represented organization: ${principal}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      // DOJ's public Search Filings destination, verified from justice.gov/nsd-fara.
      href: 'https://efile.fara.gov/ords/fara/f?p=1235:10',
      label: 'Search official FARA filings',
      guidance: identity
        ? `${identity} In Search by Field, use these details to locate the filing and verify which organization it represents.`
        : 'No registration number or organization details were supplied. Search by the names in this record, and verify the original filing before attributing it to this client.',
    };
  }

  if (record.sourceType === 'testimony') {
    const hearingId = text(record.metadata?.hearingId) ?? text(record.sourceId);
    const witness = text(record.metadata?.witness);
    return {
      href: hearingId
        ? `/legiwatch/hearings/${encodeURIComponent(hearingId)}`
        : '/legiwatch?tab=hearings',
      label: hearingId ? 'Review hearing record' : 'Find the hearing in LegiWatch',
      guidance: `${witness ? `Witness listed in source: ${witness}. ` : ''}${
        hearingId
          ? 'Review the hearing’s witness list and source materials to verify the affiliation.'
          : 'No hearing link was supplied. Search using the hearing title, witness, or date shown in this record before confirming attribution.'
      }`,
    };
  }

  return null;
}
