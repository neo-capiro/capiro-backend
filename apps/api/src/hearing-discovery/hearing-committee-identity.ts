/** Congress.gov defines a body's final two digits: 00 is the parent, other
 * digits identify a child of that same four-letter committee code.
 * https://github.com/LibraryOfCongress/api.congress.gov/blob/main/Documentation/CommitteeEndpoint.md
 * Committee-meeting committees[] contains hosting bodies, not positional
 * parent/child pairs. Never infer committee identity from hearing titles. */
export function committeeParentCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase();
  if (!code || !/^[hsj][a-z]{3}\d{2}$/.test(code)) return null;
  return `${code.slice(0, 4)}00`;
}

export function publishedCommitteeIdentity(
  committees: ReadonlyArray<{ systemCode?: string | null }> | null | undefined,
): { committeeSystemCode: string | null; subcommitteeSystemCode: string | null } {
  const codes = [...new Set((committees ?? []).map((c) => c.systemCode?.trim().toLowerCase())
    .filter((code): code is string => Boolean(code && committeeParentCode(code))))];
  const first = codes[0];
  if (!first) return { committeeSystemCode: null, subcommitteeSystemCode: null };
  const parent = committeeParentCode(first)!;
  const parents = new Set(codes.map(committeeParentCode));
  const children = codes.filter((code) => code !== committeeParentCode(code));
  return {
    // The schema has one parent slot. Preserve the first published host's
    // family for a joint meeting, without mislabelling another host as a child.
    committeeSystemCode: parent,
    subcommitteeSystemCode: parents.size === 1 && children.length === 1 ? children[0]! : null,
  };
}

/** Read legacy rows without changing their durable hearing IDs. A canonical
 * child wins over legacy fields. A legacy child can fill an absent child only
 * when its published code agrees with the canonical parent's family. */
export function storedCommitteeIdentity(row: {
  committeeSystemCode?: string | null;
  subcommitteeSystemCode?: string | null;
  committeeCode?: string | null;
}): { committeeSystemCode: string | null; subcommitteeSystemCode: string | null } {
  const canonical = row.committeeSystemCode?.trim().toLowerCase() || null;
  const legacy = row.committeeCode?.trim().toLowerCase() || null;
  const explicitChild = row.subcommitteeSystemCode?.trim().toLowerCase() || null;
  const main = canonical ?? legacy;
  const parent = committeeParentCode(main) ?? main;
  if (explicitChild) return { committeeSystemCode: parent, subcommitteeSystemCode: explicitChild };
  if (main && committeeParentCode(main) && main !== parent) {
    return { committeeSystemCode: parent, subcommitteeSystemCode: main };
  }
  const legacyParent = committeeParentCode(legacy);
  const legacyChild = legacy && legacyParent && legacy !== legacyParent && legacyParent === parent;
  return { committeeSystemCode: parent, subcommitteeSystemCode: legacyChild ? legacy : null };
}
