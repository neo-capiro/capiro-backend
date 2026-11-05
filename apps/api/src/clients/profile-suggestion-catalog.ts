import type { PrismaService } from '../prisma/prisma.service.js';
import snapshot from './reference-data/naics-psc.generated.json';
import { lookupProfileBuildReferenceCode } from './profile-build-reference-catalog.js';
import type { RegistrationField } from './profile-suggestion.contracts.js';
import type { ProfileSuggestionSource } from './profile-suggestion-sources.service.js';

export interface SuggestionCatalogEntry {
  code: string;
  label: string;
  reference?: Record<string, unknown>;
}
export async function registrationSuggestionCatalog(
  prisma: PrismaService,
  field: RegistrationField,
) {
  const entries: SuggestionCatalogEntry[] = [];
  let sourceUrl: string | undefined;
  if (field === 'naicsCodes' || field === 'pscCodes') {
    const kind = field === 'naicsCodes' ? 'naics' : 'psc';
    sourceUrl = snapshot[kind].sourceUrl;
    for (const item of snapshot[kind].entries) {
      const match = lookupProfileBuildReferenceCode(kind, item.code);
      if (match.status === 'valid')
        entries.push({
          code: match.entry.code,
          label: match.entry.label,
          reference: { ...match.entry },
        });
    }
  } else if (field === 'issueCodes') {
    sourceUrl = 'https://lobbyingdisclosure.house.gov/help/WordDocuments/lobbyingissuecodes.htm';
    const rows = await prisma.ldaIssueCode.findMany({
      select: { code: true, name: true },
      orderBy: { code: 'asc' },
    });
    for (const row of rows)
      entries.push({
        code: row.code,
        label: row.name,
        reference: {
          code: row.code,
          label: row.name,
          sourceUrl,
          kind: 'lda',
          source: 'canonical_lda_issue_codes',
        },
      });
  }
  const sources: ProfileSuggestionSource[] = [];
  for (let offset = 0; offset < entries.length; offset += 650) {
    sources.push({
      id: `reference_${offset / 650}`,
      url: sourceUrl,
      label: 'Official code reference',
      source: 'reference_catalog',
      observedAt: new Date().toISOString(),
      text: entries
        .slice(offset, offset + 650)
        .map((entry) => `${entry.code}\t${entry.label}`)
        .join('\n'),
    });
  }
  return { entries: new Map(entries.map((entry) => [entry.code, entry])), sources };
}
