# Official onboarding classification references

`naics-psc.generated.json` is a complete, source-owned snapshot for manual
classification selection. It contains no company records or inferred alignment.
The pure helper in `../profile-build-reference-catalog.ts` searches these records
in memory; requests do not fetch a website or invoke a model.

| Classification | Official source and edition | Included assignable records |
| --- | --- | --- |
| NAICS | [U.S. Census Bureau, 2022 NAICS Structure](https://www.census.gov/naics/2022NAICS/2022_NAICS_Structure.xlsx), listed on the [official NAICS page](https://www.census.gov/naics/) | All 1,012 six-digit national industries |
| PSC | [U.S. General Services Administration, PSC April 2025 workbook](https://www.acquisition.gov/sites/default/files/manual/PSC%20April%202025.xlsx), listed as current on the [official PSC manual page](https://www.acquisition.gov/psc-manual) | All 2,344 active four-character product/service codes |

Both current-edition pages were checked on 2026-11-04. Proposed 2027 NAICS
changes are not adopted in the 2022 edition. The PSC manual was published
2025-04-08 and is effective April 2025. The NAICS workbook does not supply an
exact publication/effective day, so those are not invented: its edition is 2022,
and `sourcePublishedAt`/per-code `validFrom` remain null.

The source publishers retain attribution. Code/title data is U.S. federal
government classification material, reproduced as factual reference data; no
government endorsement is implied. Only codes, titles and applicable PSC start
dates are extracted. Workbook graphics, category-manager contacts, descriptions
and other nonessential content are not redistributed. The original workbooks
are not checked in; their exact SHA-256 digests are pinned in the generator and
recorded in the generated snapshot.

NAICS sector/subsector/group rows and PSC category/group rows are excluded from
assignable suggestions. The PSC workbook includes historical versions of codes:
only rows without an end date are active. A retired version does not retire a
code that has a newer active version. The 1,310 four-character codes with only
ended rows are retained as an inactive-code set to distinguish retired input
from an unknown code. Search never returns these as suggestions. Formatting
alone does not validate a code; saves must use `lookupProfileBuildReferenceCode`
and require `status: 'valid'`. Older saved values can be displayed as history but
must not be silently relabeled as current. Catalog membership verifies only that
a classification exists, not that it applies to a company.

This exact official-code snapshot does not change the practitioner-review
requirement for proposed health/agriculture strategy references.

## Reproduction and updates

The generator reuses the repository's existing `exceljs` dependency and performs
no database writes. Run from `apps/api` with the qualified Node 24 toolchain and
the existing frozen-lockfile installation:

```sh
node --import tsx scripts/generate-profile-build-reference-catalog.ts --help
node --import tsx scripts/generate-profile-build-reference-catalog.ts --download --check
```

For offline reproduction, place the source files under their exact names
`2022_NAICS_Structure.xlsx` and `PSC_April_2025.xlsx` in a temporary directory:

```sh
node --import tsx scripts/generate-profile-build-reference-catalog.ts --source-dir /path/to/sources --check
```

Omit `--check` to regenerate the JSON. Regeneration is deterministic, including
metadata, and uses the reviewed retrieval date rather than the execution date.
No arguments, incompatible flags, and unknown flags exit 2 before network or
writes. `--help` exits 0 without side effects. Download/source/checksum/schema/
count/reproduction failures exit 1. A successful generation/check exits 0.
The generator is discovered by the existing `scripts/cleanup-script-smoke`
entrypoint scanner; it needs no package script or separate registry.

To update, verify the current edition at both official landing pages, download
the official files, review changed/removed codes and source status, then update
the generator's URLs, edition, retrieval date, source digest and expected counts.
Run the generator, inspect the generated diff and rerun the catalog tests. A
changed workbook digest fails closed until reviewed; downloads never silently
replace a pinned edition. Recheck currency before release. Status means active
in the pinned edition, not a promise of continuous online freshness.

```sh
corepack pnpm --filter @capiro/api run test --runInBand --runTestsByPath src/clients/profile-build-reference-catalog.spec.ts
```
