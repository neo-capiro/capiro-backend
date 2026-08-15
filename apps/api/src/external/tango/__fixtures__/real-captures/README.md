# Real captures — deliberately exempt from the sibling "fixtures are synthetic" rule

`tango.client.spec.ts`'s `describe('the fixtures are synthetic', ...)` block requires every
`.json` file directly under `__fixtures__/` to carry a `_comment` containing `SYNTHETIC`,
because a fixture captured from a live TENANT would freeze that tenant's real, private data
into the repository.

The two files in this subdirectory are not that. They are five records each, captured
2026-08-09 (decision-log D-71) from `/api/dibbs/` and `/api/sbir/` — **public federal
procurement data**: DLA bid-board postings, small-business award identifiers (UEI, CAGE,
legal business name — all public record under federal contract-award transparency
requirements), and public SBIR/STTR solicitation topics from sbir.gov / dodsbirsttr.mil.
There is no Capiro tenant, no private company data, and no secret in either file.

They live in this subdirectory rather than being marked `SYNTHETIC` and dropped into the
parent, because they are the opposite of synthetic on purpose: `tango-dibbs.mapper.spec.ts`
and `tango-sbir.mapper.spec.ts` run every mapper against these exact records as a permanent
regression test, and marking real data as synthetic to satisfy a filename convention would be
the same category of dishonesty this program has spent P40–P43 refusing everywhere else.

Being a subdirectory (not a `.json` file at this level) is what keeps
`tango.client.spec.ts`'s `readdirSync(FIXTURES).filter(f => f.endsWith('.json'))` scan from
ever seeing these files — that scan is scoped to the parent directory only, deliberately.
