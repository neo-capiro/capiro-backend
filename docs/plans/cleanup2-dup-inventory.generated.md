# CleanUp2 duplication ledger (GENERATED — do not hand-edit)

Regenerate with:

```bash
.graphify-venv/Scripts/python.exe .graphify_ledger.py
```

Human decisions live in `cleanup2-dup-status.md`, keyed by `group_id`. Regenerating this file never touches that one.

## Totals

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| all areas | 1684 | 22,102 | 1411 |
| **production only** (this plan) | **1126** | **12,721** | 994 |
| test-area (CleanUp3) | 558 | 9,381 | 417 |

## By subject

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| `02-web` | 632 | 9,248 | 536 |
| `01-api` | 691 | 8,618 | 579 |
| `08-platform` | 140 | 1,980 | 111 |
| `04-meri` | 79 | 787 | 62 |
| `03-defense` | 68 | 740 | 57 |
| `05-strategy` | 34 | 465 | 29 |
| `06-intel` | 19 | 138 | 19 |
| `07-workspace-onboard` | 21 | 126 | 18 |

## By wave

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| `1` | 963 | 9,899 | 963 |
| `CleanUp3` | 558 | 9,381 | 417 |
| `2` | 122 | 2,245 | 0 |
| `3` | 40 | 576 | 31 |
| `5` | 1 | 1 | 0 |

## By area

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| `test` | 558 | 9,381 | 417 |
| `other` | 722 | 7,438 | 648 |
| `script` | 285 | 4,034 | 241 |
| `src` | 118 | 1,248 | 105 |
| `config` | 1 | 1 | 0 |

## By language

| | groups | wasted lines | STRICT-identical |
|---|---:|---:|---:|
| `ts` | 1644 | 21,526 | 1380 |
| `python` | 40 | 576 | 31 |

## Mirror obligations (Phase 8 Session 4 strangler)

`apps/defense-api/runtime-source/**` is a byte-identical copy of parts of `apps/api`, enforced by `scripts/verify-phase8-session4.mjs` via **git tree-SHA equality** and wired into 8 CI workflows. It is deliberate and cannot be removed by sharing code: `apps/defense-api/src/runtime` is forbidden from importing anything under `apps/api`.

Two consequences encoded below:

1. Mirror-only groups are **excluded** from this inventory — editing the mirror is never the fix. Groups also present in the source tree appear once, under that tree.
2. Groups marked **mirror=yes** must have their change landed on **both** sides in the same commit, or CI fails. There are 184 such groups.

Mirrored pairs:

| source | mirror | check |
|---|---|---|
| `apps/api/src/defense-budget/` | `apps/defense-api/runtime-source/defense-budget/` | tree SHA equality |
| `apps/api/src/program-element/snapshot/` | `apps/defense-api/runtime-source/program-element/snapshot/` | tree SHA equality |
| `apps/api/src/program-element/source-document/` | `apps/defense-api/runtime-source/program-element/source-document/` | tree SHA equality |
| `apps/api/src/program-element/deltas/` | `apps/defense-api/runtime-source/program-element/deltas/` | tree SHA equality |
| `apps/api/src/program-element/program-element-change-outbox.service.ts` | *(under runtime-source)* | blob content equality |
| `apps/api/src/program-element/program-element-change-outbox.service.spec.ts` | *(under runtime-source)* | blob content equality |
| `apps/api/scripts/phase6-stage-cycle.ts` | *(under runtime-source)* | blob content equality |
| `apps/api/scripts/plan-defense-budget-promotion-v1.ts` | *(under runtime-source)* | blob content equality |
| `apps/api/scripts/status-defense-budget-promotion-v1.ts` | *(under runtime-source)* | blob content equality |

| group_id | wave | symbol | copies | files in source tree |
|---|---|---|---:|---|
| `53a18666d09e` | 1 | `gitsha()` | 10 | 10 |
| `d6c7164609a8` | 1 | `groupcellsbyrow()` | 8 | 8 |
| `df4997cf7580` | CleanUp3 | `table` | 3 | 3 |
| `df643dec5afc` | CleanUp3 | `run` | 10 | 10 |
| `7ca138c47885` | 1 | `databasehost()` | 9 | 9 |
| `7d0059f21b21` | 1 | `stripcomments()` | 2 | 2 |
| `3b8d002fe44d` | CleanUp3 | `maketable()` | 5 | 5 |
| `911305b016cd` | CleanUp3 | `islocalurl()` | 6 | 6 |
| `10eff5a79993` | CleanUp3 | `makesource()` | 4 | 4 |
| `425d9ac3cd5a` | 1 | `argvalue()` | 11 | 11 |
| `ad1a2ad96d7e` | 1 | `mapomissionreason()` | 3 | 3 |
| `c27b6d8579a4` | CleanUp3 | `database_url` | 4 | 4 |
| `540d48e7881e` | 1 | `nonblank` | 7 | 7 |
| `bde5290ff061` | CleanUp3 | `sha` | 6 | 6 |
| `dff018acdfec` | CleanUp3 | `archive_endpoint` | 4 | 4 |
| `066fb4a228cb` | CleanUp3 | `makepage()` | 4 | 4 |
| `069c1a72569f` | CleanUp3 | `policy()` | 4 | 4 |
| `9fa2b8d817d3` | CleanUp3 | `maketable()` | 3 | 3 |
| `2ca8952137d0` | CleanUp3 | `milcon` | 6 | 6 |
| `d02c312d1543` | CleanUp3 | `om` | 6 | 6 |
| `3064100c34f4` | CleanUp3 | `result` | 2 | 2 |
| `5489e9472c2f` | CleanUp3 | `row()` | 4 | 4 |
| `066b38b55e3a` | CleanUp3 | `sha` | 2 | 2 |
| `ccaffd91ad83` | 1 | `arg()` | 8 | 8 |
| `3e5b8d69660d` | 1 | `istotalrow()` | 5 | 5 |
| `1ac1c7e412fe` | CleanUp3 | `projection()` | 2 | 2 |
| `9ec36fa8047d` | 1 | `rowstotext()` | 5 | 5 |
| `5af47e002271` | 2 | `usage()` | 8 | 8 |
| `ab94bcf5e3cb` | CleanUp3 | `archiveandregister()` | 2 | 2 |
| `ebb489178566` | CleanUp3 | `omplanrecord()` | 2 | 2 |
| `69da29845d62` | CleanUp3 | `component` | 6 | 6 |
| `12e03cffca18` | CleanUp3 | `directcandidate()` | 2 | 2 |
| `dc4ff3d8809c` | CleanUp3 | `procurement` | 5 | 5 |
| `e0b24a34aae4` | 2 | `mapnarrativetype()` | 2 | 2 |
| `1d2edbd33095` | CleanUp3 | `recordingrepository` | 2 | 2 |
| `74be3be61620` | CleanUp3 | `candidateref()` | 2 | 2 |
| `0549ac17e2ef` | CleanUp3 | `makemanifestdoc()` | 2 | 2 |
| `78bfde451bfb` | CleanUp3 | `makepage()` | 3 | 3 |
| `5ed7b8277fab` | CleanUp3 | `.readextractionartifactlocator()` | 4 | 4 |
| `8f04949963c7` | CleanUp3 | `makecell()` | 8 | 8 |
| `9c0e48987c7a` | 1 | `dispositionforrole()` | 2 | 2 |
| `7cc9b44622af` | CleanUp3 | `positionrow()` | 2 | 2 |
| `5b68d51d7f60` | CleanUp3 | `positionrow()` | 2 | 2 |
| `4c66fb647304` | CleanUp3 | `projectionplanrow()` | 2 | 2 |
| `d1473287fa21` | 1 | `comparestrings()` | 7 | 7 |
| `112cb7f9d7e6` | 1 | `extractfiscalyear()` | 2 | 2 |
| `52dbf7f9b34b` | CleanUp3 | `makepage()` | 2 | 2 |
| `a9cb32a779e2` | 1 | `nonblank` | 7 | 7 |
| `20b396a29b82` | CleanUp3 | `recordingaudit` | 4 | 4 |
| `e5ab11aba7db` | CleanUp3 | `stripcomments()` | 7 | 7 |
| `8d01333f20b8` | CleanUp3 | `.persistcompletedverification()` | 2 | 2 |
| `de7be060766b` | CleanUp3 | `context()` | 2 | 2 |
| `88fe5ddf426e` | 1 | `fundingstagetofield()` | 2 | 2 |
| `3e0ca7ff3e39` | CleanUp3 | `makecheck()` | 2 | 2 |
| `252f809db8fe` | CleanUp3 | `passingcheck()` | 2 | 2 |
| `86cbf2304013` | CleanUp3 | `makereader()` | 2 | 2 |
| `b9573b102c86` | 1 | `findheaderrow()` | 8 | 8 |
| `087985406695` | CleanUp3 | `makesource()` | 2 | 2 |
| `6d4aeac893cf` | CleanUp3 | `fundingassertion()` | 2 | 2 |
| `8b8bd080afcd` | CleanUp3 | `makecolumnbinding()` | 2 | 2 |
| `8b9c6fa95893` | CleanUp3 | `.findterminalrunbyidentity()` | 3 | 3 |
| `3d5be8edf650` | CleanUp3 | `.loadcandidaterefs()` | 2 | 2 |
| `cf29a0baaec8` | CleanUp3 | `context()` | 2 | 2 |
| `f82d4473205f` | CleanUp3 | `fundingassertions()` | 3 | 3 |
| `7dd86a784805` | 1 | `hasflag()` | 5 | 5 |
| `9a670fff72a1` | 1 | `nonblank` | 4 | 4 |
| `68d9afd62532` | CleanUp3 | `.findcertificationbycontentsha256()` | 2 | 2 |
| `37f1b57dc4c4` | CleanUp3 | `ctx()` | 2 | 2 |
| `54dfd7797cf1` | 1 | `firstevidencepage()` | 2 | 2 |
| `b246bb04b4cd` | CleanUp3 | `makenumberedpage()` | 2 | 2 |
| `41f85e0c725d` | CleanUp3 | `maketable()` | 2 | 2 |
| `a217fca8615a` | CleanUp3 | `identity` | 3 | 3 |
| `01fe361d3a65` | CleanUp3 | `input` | 3 | 3 |
| `82e11d139b90` | CleanUp3 | `lineage` | 2 | 2 |
| `776bc2ab5383` | CleanUp3 | `makerequesttable()` | 2 | 2 |
| `38ce8bb6db21` | CleanUp3 | `maketable()` | 2 | 2 |
| `ab1d08883d57` | CleanUp3 | `prismalocatorreader` | 2 | 2 |
| `25dfb674ccb0` | 2 | `provenance` | 2 | 2 |
| `7b32759927f0` | CleanUp3 | `.insertcertificationprojectionbinding()` | 2 | 2 |
| `fc61bdc06ae4` | CleanUp3 | `.record()` | 4 | 4 |
| `48dc617ee903` | 1 | `decimalequal()` | 2 | 2 |
| `10fae99b9c2b` | CleanUp3 | `table()` | 4 | 4 |
| `c32a144bfa39` | 1 | `valuesequal()` | 2 | 2 |
| `d182644c211a` | 1 | `nonblank` | 3 | 3 |
| `476ce68e2828` | CleanUp3 | `pe` | 9 | 9 |
| `0b8d496bfc17` | CleanUp3 | `sha` | 2 | 2 |
| `a9d01331b871` | 1 | `tablekey()` | 2 | 2 |
| `813a459109d2` | 1 | `deterministicuuidv1()` | 2 | 2 |
| `829d2deabf74` | CleanUp3 | `evidence` | 2 | 2 |
| `2ea83b269d09` | 1 | `extractperiodlabel()` | 2 | 2 |
| `683227689483` | CleanUp3 | `makeblock()` | 2 | 2 |
| `fa2a662828af` | 2 | `rules` | 2 | 2 |
| `8764498f0aba` | 1 | `scopekey()` | 2 | 2 |
| `9c2a4341515a` | CleanUp3 | `.insert()` | 2 | 2 |
| `eb4bc050567f` | CleanUp3 | `.persistcompletedverification()` | 2 | 2 |
| `ce5f4958942c` | CleanUp3 | `artifactbytesha()` | 3 | 3 |
| `592893c5b518` | 2 | `canonicaldecimal` | 3 | 3 |
| `e9dab0ef261f` | CleanUp3 | `column()` | 4 | 4 |
| `157d3c507ae2` | CleanUp3 | `fakehash()` | 3 | 3 |
| `5886e6e9b995` | 1 | `gaterule` | 2 | 2 |
| `b9db9a19132c` | CleanUp3 | `identity()` | 2 | 2 |
| `ddafe34c78a4` | 2 | `nextfindingid()` | 3 | 3 |
| `1adbf1dacd26` | 1 | `nonblankstring` | 2 | 2 |
| `ad69d098f6ad` | 1 | `normalizewhitespace()` | 3 | 3 |
| `d25096b8572b` | CleanUp3 | `scope` | 2 | 2 |
| `12462fbcdbc3` | CleanUp3 | `sha` | 4 | 4 |
| `8278a881181b` | CleanUp3 | `target` | 2 | 2 |
| `c940633766c4` | CleanUp3 | `.findprojectionidsforcertification()` | 2 | 2 |
| `91bd84ff9708` | 1 | `assertionmetadata` | 2 | 2 |
| `09ca54c99293` | CleanUp3 | `errorcodes()` | 2 | 2 |
| `2ed006f1d17a` | CleanUp3 | `filesystemartifactloader` | 2 | 2 |
| `27f8aa30c35f` | CleanUp3 | `identity()` | 2 | 2 |
| `21d1d47e4847` | 1 | `isodate()` | 2 | 2 |
| `0842dc2ce1c1` | CleanUp3 | `money()` | 2 | 2 |
| `dbc5823ed23b` | 1 | `narrative_sections` | 2 | 2 |
| `c920240fbc77` | 1 | `normalizedecimal()` | 2 | 2 |
| `7f32351026d9` | CleanUp3 | `profile` | 2 | 2 |
| `3c8a24907f95` | CleanUp3 | `profile` | 2 | 2 |
| `12e2d2723a20` | CleanUp3 | `profile` | 2 | 2 |
| `1908f93777c0` | CleanUp3 | `profile` | 2 | 2 |
| `3c9c1054c592` | 1 | `samepages()` | 2 | 2 |
| `8dbfe1522835` | 1 | `.headers()` | 2 | 2 |
| `2179bd6ee578` | CleanUp3 | `.pausesideeffectdrain()` | 2 | 2 |
| `35c15c43d305` | CleanUp3 | `doc()` | 3 | 3 |
| `a3cf6e72277f` | CleanUp3 | `maketable()` | 3 | 3 |
| `5dd87790c9d0` | CleanUp3 | `manifest()` | 3 | 3 |
| `1b453e06d794` | 1 | `metaboolean()` | 2 | 2 |
| `682a73c5e013` | 1 | `metastring()` | 2 | 2 |
| `939ca8248b72` | 1 | `nonblankstring` | 2 | 2 |
| `d1da8bb88b65` | CleanUp3 | `sha` | 2 | 2 |
| `7942e4a94a44` | 1 | `sourcepath()` | 2 | 2 |
| `f612595f34e2` | CleanUp3 | `.$executerawunsafe()` | 2 | 2 |
| `e6a788d8f88f` | CleanUp3 | `.countopenblockingconflicts()` | 2 | 2 |
| `90cc4928c20c` | CleanUp3 | `.countunsupportedprojections()` | 2 | 2 |
| `b8952e6f2564` | CleanUp3 | `.findterminalrunbyidentity()` | 2 | 2 |
| `a7896ca3c1f4` | CleanUp3 | `.getobject()` | 2 | 2 |
| `4daa3d96b150` | 1 | `.hasroottransaction()` | 2 | 2 |
| `add48493552d` | CleanUp3 | `.load()` | 2 | 2 |
| `f83f69da6298` | CleanUp3 | `.loadactivesnapshot()` | 2 | 2 |
| `283e999f9a67` | CleanUp3 | `.loadcandidates()` | 2 | 2 |
| `513cc1a2db4d` | CleanUp3 | `.loadcyclecertifications()` | 2 | 2 |
| `0d1fc41e993e` | CleanUp3 | `.loadforscope()` | 2 | 2 |
| `f58274adfee6` | CleanUp3 | `.loadlatestterminalrunid()` | 2 | 2 |
| `54b93b8f4bfb` | CleanUp3 | `.loadprojectionplans()` | 2 | 2 |
| `e5f0b79df673` | CleanUp3 | `.loadprojections()` | 2 | 2 |
| `ac513c025383` | CleanUp3 | `.loadverifiedartifact()` | 2 | 2 |
| `ec3ba6b3b0de` | CleanUp3 | `.readcandidate()` | 2 | 2 |
| `9491ae356809` | CleanUp3 | `.readchecks()` | 2 | 2 |
| `151b19a2ee94` | CleanUp3 | `.readdiscrepancies()` | 2 | 2 |
| `9d4a3796ae32` | CleanUp3 | `.readproofsnapshots()` | 2 | 2 |
| `e6ec49cd358c` | CleanUp3 | `.readreviewdecisions()` | 2 | 2 |
| `2eef95e64162` | CleanUp3 | `.readrun()` | 2 | 2 |
| `527d6c979e9d` | 1 | `cell` | 4 | 4 |
| `76dbf48a09dd` | CleanUp3 | `delegate()` | 2 | 2 |
| `c908c56b32c4` | CleanUp3 | `eligibility()` | 2 | 2 |
| `41508a7e1ec3` | CleanUp3 | `identity` | 4 | 4 |
| `d714947d409d` | 1 | `iso()` | 2 | 2 |
| `ada417c19db5` | 1 | `metadataof()` | 2 | 2 |
| `075f5e4cbdb1` | 1 | `num()` | 2 | 2 |
| `47921de1fb15` | 1 | `parsejobclient` | 2 | 2 |
| `d112f68f8363` | 1 | `pushcandidate()` | 2 | 2 |
| `7d734819de81` | 1 | `requireuuid()` | 2 | 2 |
| `f93b63dc7181` | 1 | `sha256hex()` | 2 | 2 |
| `6cafff2d3e6e` | 1 | `sha256hex()` | 2 | 2 |
| `7ccba8b7e355` | 1 | `sha256ofbuffer()` | 2 | 2 |
| `6da9379ad3ad` | 1 | `sha256offile()` | 2 | 2 |
| `b8b298d76c1d` | 1 | `sorteduniquepages()` | 2 | 2 |
| `e56d87585ac2` | CleanUp3 | `updatecandidatestatus()` | 2 | 2 |
| `19493e3b6c6f` | 1 | `verificationclock` | 2 | 2 |
| `14c912bf6e93` | CleanUp3 | `.insertauthorization()` | 2 | 2 |
| `3ac7a01c77f9` | 1 | `documentfactassertionv1` | 3 | 3 |
| `857fceb958a6` | 1 | `eligibility()` | 2 | 2 |
| `1a44a2f7e977` | 1 | `maplabelcolumns()` | 2 | 2 |
| `4fb51a9808dc` | 1 | `narrative_sections` | 2 | 2 |
| `9c479fad9ab5` | CleanUp3 | `uuid()` | 2 | 2 |
| `9faafbccf880` | CleanUp3 | `$queryrawunsafe()` | 2 | 2 |
| `9d18c5f3d6e6` | 1 | `.updatemany()` | 2 | 2 |
| `a0d8823f25c8` | CleanUp3 | `a` | 2 | 2 |
| `ec39d735db93` | CleanUp3 | `b` | 2 | 2 |
| `e39fe25c79ee` | CleanUp3 | `fundingassertion` | 2 | 2 |
| `d276417cd0dd` | CleanUp3 | `money()` | 2 | 2 |
| `83e90b91a041` | 1 | `notprintedschema` | 2 | 2 |
| `4bfebd6c4b65` | CleanUp3 | `pe2` | 2 | 2 |
| `39feb4e5be3a` | 1 | `pe_identity` | 2 | 2 |

## Full inventory

| group_id | wave | subject | symbol | copies | lines/copy | wasted | STRICT | mirror | anchor file |
|---|---|---|---|---:|---:|---:|:---:|:---:|---|
| `1a817029701b` | CleanUp3 | 02-web | `setupbrowsermocks()` | 23 | 23 | 506 | yes | — | `apps\web\src\pages\clients\tracker\TrackerConfigPanel.email.test.tsx` |
| `15798e7fc35a` | CleanUp3 | 02-web | `setupantdbrowsermocks()` | 17 | 21 | 336 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `8278fd9d74d8` | CleanUp3 | 02-web | `client` | 15 | 17 | 238 | yes | — | `apps\web\src\vnext\adapters\legacy\useClientCrmOverviewModel.test.tsx` |
| `6077a3bf4295` | CleanUp3 | 02-web | `setupbrowsermocks()` | 9 | 26 | 208 | yes | — | `apps\web\src\pages\actions\ActionBoardPage.test.tsx` |
| `a0eec44e32a6` | CleanUp3 | 01-api | `ctx` | 29 | 7 | 196 | **no** | — | `apps\api\scripts\meri-durable-controls.http.integration.spec.ts` |
| `f2463fdb417d` | CleanUp3 | 01-api | `ctx` | 25 | 7 | 168 | **no** | — | `apps\api\src\engagement\engagement-audiences.spec.ts` |
| `0e66e065488a` | 1 | 01-api | `arg()` | 40 | 4 | 156 | yes | — | `apps\api\scripts\attach-pe-legacy-documents.ts` |
| `125ee2d41468` | 2 | 08-platform | `results` | 3 | 78 | 156 | **no** | — | `scripts\legiwatch-phase6-upgrade.mjs` |
| `fd0b30067a7b` | CleanUp3 | 01-api | `repositorypath()` | 17 | 9 | 144 | yes | — | `apps\api\src\knowledge\entities\canonical-backfill-checkpoint-resume-verifier.contract.spec.ts` |
| `ade534d83cfc` | CleanUp3 | 02-web | `setupbrowsermocks()` | 7 | 22 | 132 | yes | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.test.tsx` |
| `65f8658fb99f` | 2 | 02-web | `errormessage()` | 16 | 8 | 120 | **no** | — | `apps\web\src\components\AppShell.tsx` |
| `4842ee9bb556` | 1 | 01-api | `flagvalue()` | 21 | 6 | 120 | yes | — | `apps\api\scripts\backfill-sam-opportunity-fields.ts` |
| `50fc40c8b4dc` | CleanUp3 | 02-web | `hr8800()` | 2 | 120 | 120 | yes | — | `apps\web\src\pages\bills\Bill360Page.test.tsx` |
| `53a18666d09e` | 1 | 01-api | `gitsha()` | 10 | 13 | 117 | yes | **yes** | `apps\api\scripts\authorize-defense-budget-promotion-v1.ts` |
| `fee6a743689b` | 2 | 02-web | `waterfall()` | 2 | 111 | 111 | **no** | — | `apps\web\src\pages\program-element\v2\PeV2FundingTab.tsx` |
| `d6c7164609a8` | 1 | 01-api | `groupcellsbyrow()` | 8 | 15 | 105 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.ts` |
| `b94a525b2741` | CleanUp3 | 02-web | `setupapi()` | 2 | 105 | 105 | yes | — | `apps\web\src\pages\program-element\ProgramElementWatchPage.test.tsx` |
| `df4997cf7580` | CleanUp3 | 01-api | `table` | 3 | 47 | 94 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-verification-wiring.spec.ts` |
| `abdc51bbb26e` | 1 | 02-web | `cartesianaxes()` | 2 | 83 | 83 | yes | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `8ec652c85a62` | 1 | 02-web | `detailsfor()` | 2 | 83 | 83 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `dc0c1a165e7d` | CleanUp3 | 02-web | `entry()` | 2 | 83 | 83 | yes | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `df643dec5afc` | CleanUp3 | 01-api | `run` | 10 | 9 | 81 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\conference\appropriations-conference-v1.spec.ts` |
| `f6348327cf08` | CleanUp3 | 02-web | `setupbrowsermocks()` | 4 | 27 | 81 | yes | — | `apps\web\src\pages\clients\tracker\TrackerTab.boardviews.test.tsx` |
| `7ca138c47885` | 1 | 01-api | `databasehost()` | 9 | 10 | 80 | yes | **yes** | `apps\api\scripts\audit-llamaparse-pe-units.ts` |
| `249000021918` | CleanUp3 | 02-web | `setupantdbrowsermocks()` | 5 | 20 | 80 | yes | — | `apps\web\src\pages\directory\CommitteeContactList.test.tsx` |
| `e69608a24dce` | CleanUp3 | 02-web | `approval()` | 3 | 38 | 76 | yes | — | `apps\web\src\vnext\meri\MeriApprovalNotice.test.tsx` |
| `85e1809bfacd` | CleanUp3 | 01-api | `target()` | 4 | 25 | 75 | **no** | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-approval.service.spec.ts` |
| `a925e39544a1` | 1 | 01-api | `flag()` | 25 | 3 | 72 | yes | — | `apps\api\scripts\attach-pe-legacy-documents.ts` |
| `8315357a0b89` | 1 | 02-web | `hearingroomviewmodel` | 2 | 72 | 72 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `aa8bf10f03c6` | CleanUp3 | 01-api | `source()` | 5 | 18 | 72 | yes | — | `apps\api\src\clients\client-profile-fill-context-plane.service.spec.ts` |
| `7d0059f21b21` | 1 | 01-api | `stripcomments()` | 2 | 72 | 72 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-phase5-gates-v1.ts` |
| `40a0679aab7b` | CleanUp3 | 01-api | `makerow()` | 2 | 70 | 70 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `bc366f44ea7f` | 2 | 02-web | `heatmapvisual()` | 2 | 69 | 69 | **no** | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `a6e06e13d00c` | 1 | 01-api | `asrecord()` | 14 | 5 | 65 | yes | — | `apps\api\scripts\audit-llamaparse-pe-units.ts` |
| `a1cc79466f40` | CleanUp3 | 02-web | `staff` | 2 | 64 | 64 | yes | — | `apps\web\src\pages\directory\StaffDirectoryProfilePage.test.tsx` |
| `45d85455ebf1` | CleanUp3 | 01-api | `ctx` | 10 | 7 | 63 | **no** | — | `apps\api\src\meri\governed-meri-tools.chart-scope.spec.ts` |
| `2ca02a0080d1` | CleanUp3 | 01-api | `prismamock()` | 4 | 21 | 63 | yes | — | `apps\api\src\defense-budget-lifecycle\defense-budget-lifecycle-internal.guard.spec.ts` |
| `417175704e6e` | 1 | 02-web | `waterfallvisual()` | 2 | 61 | 61 | yes | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `44d7fe48c7bc` | 2 | 08-platform | `hash()` | 3 | 30 | 60 | **no** | — | `scripts\legiwatch-phase6-upgrade.mjs` |
| `1f136938f890` | CleanUp3 | 02-web | `makeitem()` | 4 | 20 | 60 | **no** | — | `apps\web\src\pages\clients\tracker\MemoComposerDrawer.existing.test.tsx` |
| `39c21bfddd67` | CleanUp3 | 02-web | `node()` | 4 | 20 | 60 | yes | — | `apps\web\src\vnext\pages\strategies\StrategyEditorVNext.dirty-guard.test.tsx` |
| `ddef1134b4f6` | 2 | 01-api | `.assertenabledfortenant()` | 2 | 58 | 58 | **no** | — | `apps\api\src\district-nexus\district-nexus-flag.guard.ts` |
| `d3cfacc15244` | 1 | 01-api | `fips_to_state` | 2 | 58 | 58 | yes | — | `apps\api\scripts\sync-district-economic-acs.ts` |
| `bf13f5367007` | 2 | 08-platform | `migrate()` | 3 | 29 | 58 | **no** | — | `scripts\legiwatch-phase6-upgrade.mjs` |
| `eb8b2a402ef2` | 2 | 02-web | `card_defs` | 2 | 57 | 57 | **no** | — | `apps\web\src\pages\bills\BillOverviewTab.tsx` |
| `c1507d88ff2b` | CleanUp3 | 05-strategy | `rec` | 15 | 4 | 56 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `3f34e682d0ee` | 2 | 08-platform | `seedidentity()` | 3 | 28 | 56 | **no** | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `9df17b6b5f4d` | CleanUp3 | 02-web | `member` | 2 | 55 | 55 | yes | — | `apps\web\src\pages\directory\MemberDirectoryProfilePage.test.tsx` |
| `4edce47585af` | CleanUp3 | 05-strategy | `governed()` | 2 | 54 | 54 | yes | — | `apps\api-strategy\src\meri\governed-strategy-meri.factory.spec.ts` |
| `27218691dcff` | CleanUp3 | 02-web | `resolveget()` | 2 | 54 | 54 | yes | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `123488fd446d` | 1 | 02-web | `scattervisual()` | 2 | 53 | 53 | yes | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `32d6e0a0d2e1` | CleanUp3 | 01-api | `ctx` | 14 | 4 | 52 | **no** | — | `apps\api\src\client-documents\client-document-writer.service.spec.ts` |
| `4799c5f17216` | 2 | 02-web | `billoverviewtab()` | 2 | 50 | 50 | **no** | — | `apps\web\src\pages\bills\BillOverviewTab.tsx` |
| `f130dfec34b7` | CleanUp3 | 01-api | `shadowpolicy()` | 6 | 10 | 50 | yes | — | `apps\api\src\client-documents\client-document-writer.service.spec.ts` |
| `829496ea7bae` | 1 | 02-web | `connectchrome()` | 5 | 12 | 48 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `4160fdef4d60` | CleanUp3 | 02-web | `getmock` | 9 | 6 | 48 | **no** | — | `apps\web\src\vnext\pages\client-crm\AddRelationshipModal.test.tsx` |
| `3b8d002fe44d` | CleanUp3 | 01-api | `maketable()` | 5 | 12 | 48 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\op5\op5-extractor-v1.spec.ts` |
| `851f7e745de0` | 1 | 01-api | `safedate()` | 9 | 6 | 48 | yes | — | `apps\api\scripts\sync-congress.ts` |
| `14c0de6bff0d` | 2 | 02-web | `pievisual()` | 2 | 47 | 47 | **no** | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `f3a87b297d75` | CleanUp3 | 02-web | `envelope()` | 2 | 46 | 46 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `21ee25d67559` | 1 | 01-api | `hasflag()` | 16 | 3 | 45 | yes | — | `apps\api\scripts\backfill-sam-opportunity-fields.ts` |
| `911305b016cd` | CleanUp3 | 01-api | `islocalurl()` | 6 | 9 | 45 | yes | **yes** | `apps\api\scripts\qualify-defense-budget-drain-image-v1.integration.spec.ts` |
| `4703bd1219e3` | CleanUp3 | 02-web | `locationprobe()` | 6 | 9 | 45 | **no** | — | `apps\web\src\pages\clients\tracker\MemoComposerDrawer.held.test.tsx` |
| `de65adc40e41` | CleanUp3 | 02-web | `meridir` | 10 | 5 | 45 | yes | — | `apps\web\src\vnext\meri\MeriArtifactCanvas.test.ts` |
| `6676dfdf0442` | 1 | 01-api | `.mergeuseridentity()` | 2 | 44 | 44 | yes | — | `apps\api\src\auth\clerk-provisioning.service.ts` |
| `ba40f0e4a6ba` | 1 | 01-api | `boundedjson()` | 5 | 11 | 44 | yes | — | `apps\api\src\context\meetings-context-plane.runtime.ts` |
| `8b1e586abba3` | 2 | 04-meri | `stablestringify()` | 5 | 11 | 44 | **no** | — | `packages\meriv2-core\src\assurance\claim-ledger.ts` |
| `819636e38bc9` | CleanUp3 | 02-web | `apigetmock` | 8 | 6 | 42 | **no** | — | `apps\web\src\pages\admin\PeReconciliationPage.test.tsx` |
| `f4ce1081cda9` | 1 | 01-api | `arg()` | 7 | 7 | 42 | yes | — | `apps\api\scripts\backfill-client-kb.ts` |
| `9c366afbe002` | 1 | 04-meri | `extractbearertoken()` | 7 | 7 | 42 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat.controller.ts` |
| `a1253df3ae98` | 1 | 08-platform | `here` | 4 | 14 | 42 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `90bb96c3738d` | 1 | 08-platform | `listtrackedfiles()` | 3 | 21 | 42 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `10eff5a79993` | CleanUp3 | 01-api | `makesource()` | 4 | 14 | 42 | **no** | **yes** | `apps\api\src\defense-budget\non-rdte\p1\p1-extractor-v1.spec.ts` |
| `8cc34ba3f4e3` | 1 | 02-web | `tochartpoint()` | 2 | 42 | 42 | yes | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `425d9ac3cd5a` | 1 | 01-api | `argvalue()` | 11 | 4 | 40 | yes | **yes** | `apps\api\scripts\authorize-defense-budget-promotion-v1.ts` |
| `767378cbccc5` | 1 | 02-web | `formatdatetime()` | 6 | 8 | 40 | yes | — | `apps\web\src\pages\engagement\EngagementPage.tsx` |
| `ad1a2ad96d7e` | 1 | 01-api | `mapomissionreason()` | 3 | 20 | 40 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-artifact-builder-v1.ts` |
| `e6cff6b6639c` | CleanUp3 | 02-web | `postmock` | 9 | 5 | 40 | **no** | — | `apps\web\src\vnext\pages\client-crm\AddRelationshipModal.test.tsx` |
| `508baaecea9f` | 2 | 08-platform | `required()` | 9 | 5 | 40 | **no** | — | `scripts\engagement-phase3-api-replay.mjs` |
| `c9f4d1161ed8` | 1 | 08-platform | `parse()` | 4 | 13 | 39 | yes | — | `scripts\run-engagement-phase1-local.mjs` |
| `782f12c648d9` | 1 | 08-platform | `reporoot` | 4 | 13 | 39 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `10cf0a6b1f50` | CleanUp3 | 05-strategy | `node()` | 3 | 19 | 38 | yes | — | `apps\api-strategy\src\reports\pdf-report.renderer.spec.ts` |
| `a061e02a9120` | 1 | 02-web | `pickheadlineclaim()` | 2 | 37 | 37 | yes | — | `apps\web\src\pages\program-element\PeTrustHeader.tsx` |
| `645390da73b3` | 2 | 01-api | `complete()` | 3 | 18 | 36 | **no** | — | `apps\api\scripts\eval-clio-analysis.ts` |
| `c27b6d8579a4` | CleanUp3 | 01-api | `database_url` | 4 | 12 | 36 | yes | **yes** | `apps\api\scripts\qualify-defense-budget-drain-image-v1.integration.spec.ts` |
| `c5058dd7641e` | CleanUp3 | 02-web | `makecard()` | 2 | 36 | 36 | yes | — | `apps\web\src\pages\actions\ActionBoardPage.test.tsx` |
| `540d48e7881e` | 1 | 01-api | `nonblank` | 7 | 6 | 36 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\milcon-native-identity-supplement-v1.ts` |
| `d9db4d15594f` | 1 | 01-api | `parsesections()` | 2 | 36 | 36 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `a0176d905a71` | 1 | 01-api | `totenantcontext()` | 5 | 9 | 36 | yes | — | `apps\api\src\capabilities\context\get-document.capability.ts` |
| `f901903e6fb5` | CleanUp3 | 02-web | `apipostmock` | 8 | 5 | 35 | **no** | — | `apps\web\src\pages\admin\PeReconciliationPage.test.tsx` |
| `497a2934dc3c` | CleanUp3 | 01-api | `apiroot()` | 8 | 5 | 35 | **no** | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `a5edc89f0c5c` | 1 | 08-platform | `banned_governed_write_symbols` | 2 | 35 | 35 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `4f9005f4cf0e` | CleanUp3 | 01-api | `ctx` | 6 | 7 | 35 | **no** | — | `apps\api\src\learning\learning-signal-query.service.spec.ts` |
| `a334eb17d7fc` | 1 | 01-api | `record()` | 8 | 5 | 35 | yes | — | `apps\api\scripts\sync-openstates-events.ts` |
| `bde5290ff061` | CleanUp3 | 01-api | `sha` | 6 | 7 | 35 | **no** | **yes** | `apps\api\src\defense-budget\non-rdte\o1\o1-extractor-v1.spec.ts` |
| `f643b50381f0` | 2 | 08-platform | `grantprobe()` | 3 | 17 | 34 | **no** | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `13cee2c782ce` | 1 | 01-api | `resolvetenants()` | 3 | 17 | 34 | yes | — | `apps\api\scripts\backfill-client-kb.ts` |
| `e4e81a8e3505` | 3 | 03-defense | `_bbox()` | 4 | 11 | 33 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `dff018acdfec` | CleanUp3 | 01-api | `archive_endpoint` | 4 | 11 | 33 | yes | **yes** | `apps\api\scripts\qualify-defense-budget-drain-image-v1.integration.spec.ts` |
| `4df37828a55b` | 1 | 08-platform | `argv` | 4 | 11 | 33 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `9d2d576c3f26` | 1 | 02-web | `initials()` | 4 | 11 | 33 | yes | — | `apps\web\src\pages\directory\DowDirectoryResults.tsx` |
| `066fb4a228cb` | CleanUp3 | 01-api | `makepage()` | 4 | 11 | 33 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-extractor-v1.spec.ts` |
| `069c1a72569f` | CleanUp3 | 01-api | `policy()` | 4 | 11 | 33 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-verification-wiring.spec.ts` |
| `4a41e4cb0d90` | CleanUp3 | 04-meri | `policy()` | 2 | 33 | 33 | **no** | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-capture-evidence.spec.ts` |
| `7fa799b2756e` | 1 | 08-platform | `requiretokens()` | 4 | 11 | 33 | yes | — | `scripts\verify-phase8-session10.mjs` |
| `4dd05e87a4d1` | CleanUp3 | 02-web | `stubfetch()` | 2 | 33 | 33 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `1a7cfe1e4b01` | 3 | 03-defense | `_table_matrix()` | 5 | 8 | 32 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\extractor.py` |
| `49c3682cc7c3` | 1 | 02-web | `amounttreatmentlabel()` | 3 | 16 | 32 | yes | — | `apps\web\src\pages\bills\BillFundingTab.tsx` |
| `9a8671d6e868` | CleanUp3 | 02-web | `apititle()` | 2 | 32 | 32 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictFederalMarketPanel.test.tsx` |
| `9aace34ae5c6` | CleanUp3 | 02-web | `makemeeting()` | 2 | 32 | 32 | **no** | — | `apps\web\src\pages\engagement\meetings\ShareConfirmation.render.test.tsx` |
| `b057bb83a3c1` | CleanUp3 | 01-api | `now` | 5 | 8 | 32 | **no** | — | `apps\api\src\engagement\generation\author-style-profile.service.spec.ts` |
| `1b1b678b0274` | 2 | 02-web | `realizationratelabel()` | 2 | 32 | 32 | **no** | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `0ab0ab480f83` | 2 | 08-platform | `scriptdir` | 9 | 4 | 32 | **no** | — | `scripts\verify-phase8-session10-db.mjs` |
| `ed18d72fd099` | 1 | 02-web | `chartpoint` | 2 | 31 | 31 | yes | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `dc7110e7be0d` | 2 | 02-web | `coverageband()` | 2 | 31 | 31 | **no** | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `e9275dbdd20f` | 2 | 02-web | `explicit_link_types` | 2 | 31 | 31 | **no** | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `7a3c0d910bbd` | CleanUp3 | 01-api | `plan()` | 2 | 31 | 31 | **no** | — | `apps\api\src\outreach-v3\generation\outreach-v3-full-generation-job.spec.ts` |
| `cb01dcca9ea8` | 1 | 02-web | `track` | 2 | 31 | 31 | yes | — | `apps\web\src\pages\program-element\v2\PeV2Congressional.tsx` |
| `6c7b29f01cdb` | 1 | 01-api | `updatemeetingdto` | 2 | 31 | 31 | yes | — | `apps\api\src\engagement\engagement.controller.ts` |
| `6dc672437671` | 1 | 01-api | `.securityenvelope()` | 2 | 30 | 30 | yes | — | `apps\api\src\engagement\generation\outreach-context-plane.service.ts` |
| `ba6d1066174e` | 1 | 08-platform | `baseindex` | 4 | 10 | 30 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `5da88174ed89` | 1 | 02-web | `clusterevents()` | 2 | 30 | 30 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `a952f47b85e1` | 1 | 08-platform | `csv()` | 4 | 10 | 30 | yes | — | `infra\cdk\bin\defense-budget-annual-operations.ts` |
| `68b32f9c342e` | CleanUp3 | 01-api | `ctx` | 7 | 5 | 30 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-approval.service.spec.ts` |
| `41bc217b4049` | CleanUp3 | 04-meri | `ctx` | 6 | 6 | 30 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.spec.ts` |
| `857e9d9f446e` | 1 | 08-platform | `databaseurl()` | 4 | 10 | 30 | yes | — | `scripts\run-outreach-v3-phase2-flow-db.mjs` |
| `9147564eb7e7` | CleanUp3 | 01-api | `entity` | 3 | 15 | 30 | **no** | — | `apps\api\src\knowledge\entities\canonical-entity-registration.service.spec.ts` |
| `9fa2b8d817d3` | CleanUp3 | 01-api | `maketable()` | 3 | 15 | 30 | yes | **yes** | `apps\api\src\defense-budget\rdte\r2a\r2a-project-funding-extractor-v1.spec.ts` |
| `2ca8952137d0` | CleanUp3 | 01-api | `milcon` | 6 | 6 | 30 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `d02c312d1543` | CleanUp3 | 01-api | `om` | 6 | 6 | 30 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `c918c08e5ed2` | CleanUp3 | 02-web | `readmeri()` | 11 | 3 | 30 | yes | — | `apps\web\src\vnext\meri\MeriArtifactCanvas.test.ts` |
| `d0ae3b484084` | 2 | 01-api | `required()` | 7 | 5 | 30 | **no** | — | `apps\api\scripts\bind-engagement-phase3-auth-fixtures.ts` |
| `f68eb394c293` | 1 | 02-web | `required()` | 7 | 5 | 30 | yes | — | `apps\web\scripts\engagement-phase0-browser-acceptance.mjs` |
| `3064100c34f4` | CleanUp3 | 01-api | `result` | 2 | 30 | 30 | **no** | **yes** | `apps\api\src\defense-budget\parser-router\congressional-durable-semantic-artifact-factory-v1.spec.ts` |
| `5489e9472c2f` | CleanUp3 | 01-api | `row()` | 4 | 10 | 30 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `066b38b55e3a` | CleanUp3 | 01-api | `sha` | 2 | 30 | 30 | **no** | **yes** | `apps\api\src\defense-budget\phase6\phase6-audit-projection-repository.spec.ts` |
| `03a77ac64ad6` | 1 | 01-api | `assertknownflags()` | 2 | 29 | 29 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `5e3b4407b4c4` | 1 | 02-web | `cellfor()` | 2 | 29 | 29 | yes | — | `apps\web\src\pages\program-element\v2\PeV2Congressional.tsx` |
| `ccaffd91ad83` | 1 | 01-api | `arg()` | 8 | 4 | 28 | yes | **yes** | `apps\api\scripts\backfill-federal-award-dates.ts` |
| `70de0b4b7460` | CleanUp3 | 01-api | `controllerroutes()` | 3 | 14 | 28 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `6ba5d322530f` | CleanUp3 | 01-api | `ctx` | 29 | 1 | 28 | **no** | — | `apps\api\src\clients\client-advocacy-record-read.service.spec.ts` |
| `7566795f1201` | CleanUp3 | 01-api | `ctx` | 5 | 7 | 28 | **no** | — | `apps\api\src\engagement\generation\author-style-profile.service.spec.ts` |
| `3e5b8d69660d` | 1 | 01-api | `istotalrow()` | 5 | 7 | 28 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.ts` |
| `9956d283561c` | CleanUp3 | 01-api | `manifest()` | 2 | 28 | 28 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-refine.service.spec.ts` |
| `1ac1c7e412fe` | CleanUp3 | 01-api | `projection()` | 2 | 28 | 28 | **no** | **yes** | `apps\api\src\defense-budget\phase6\phase6-audit-projection-repository.spec.ts` |
| `d6506d752e4f` | 1 | 01-api | `resolveapiroot()` | 5 | 7 | 28 | yes | — | `apps\api\scripts\lib\memory-phase2-notification-assignment-contract.spec.ts` |
| `9ec36fa8047d` | 1 | 01-api | `rowstotext()` | 5 | 7 | 28 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\op5\op5-extractor-v1.ts` |
| `95481b4e2ef8` | 2 | 02-web | `safename()` | 5 | 7 | 28 | **no** | — | `apps\web\scripts\engagement-phase0-browser-acceptance.mjs` |
| `9dadd44819fe` | CleanUp3 | 02-web | `sanitizelocation()` | 2 | 28 | 28 | yes | — | `apps\web\src\vnext\adapters\legacy\useDashboardVNextModel.sanitize-location.test.ts` |
| `d6333169bf71` | CleanUp3 | 02-web | `summary` | 2 | 28 | 28 | yes | — | `apps\web\src\pages\settings\AiUsagePage.test.tsx` |
| `cbee10f9a742` | 1 | 02-web | `uploadtos3()` | 5 | 7 | 28 | yes | — | `apps\web\src\pages\admin\ClientsPage.tsx` |
| `5af47e002271` | 2 | 01-api | `usage()` | 8 | 4 | 28 | **no** | **yes** | `apps\api\scripts\authorize-defense-budget-promotion-v1.ts` |
| `8cf281aae0ab` | 3 | 03-defense | `_row_reference()` | 4 | 9 | 27 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `ab94bcf5e3cb` | CleanUp3 | 01-api | `archiveandregister()` | 2 | 27 | 27 | **no** | **yes** | `apps\api\src\defense-budget\governed-acceptance\candidate-correction\phase10b35c-candidate-correction-e2e.integration.spec.ts` |
| `bc9fef323039` | 1 | 04-meri | `isrecord()` | 10 | 3 | 27 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-clean-assistant.service.ts` |
| `ebb489178566` | CleanUp3 | 01-api | `omplanrecord()` | 2 | 27 | 27 | yes | **yes** | `apps\api\src\defense-budget\promotion\eligibility-bound-projection-source-prisma-v1.spec.ts` |
| `fa1837355f99` | 1 | 01-api | `referenceinventory()` | 2 | 27 | 27 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `44eef23d56f9` | 2 | 02-web | `segmented()` | 2 | 27 | 27 | **no** | — | `apps\web\src\pages\program-element\v2\pe-v2-primitives.tsx` |
| `5fa77c1d6198` | 2 | 02-web | `timelinevisual()` | 2 | 27 | 27 | **no** | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `25df3cefc5c2` | 3 | 03-defense | `_detect_unit()` | 3 | 13 | 26 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `1271abaa06a7` | 1 | 04-meri | `documentreferences()` | 2 | 26 | 26 | yes | — | `apps\meriv2-orchestrator\src\meri\jev\shadow-claim-assessor.ts` |
| `740bea89a004` | 2 | 01-api | `mapcapabilityerror()` | 2 | 26 | 26 | **no** | — | `apps\api\src\outreach-v3\context\outreach-v3-context.service.ts` |
| `6117a018fad2` | 2 | 08-platform | `run()` | 3 | 13 | 26 | **no** | — | `scripts\verify-outreach-v3-phase4-code.mjs` |
| `a593453128d4` | 1 | 02-web | `uploadclientlogo()` | 3 | 13 | 26 | yes | — | `apps\web\src\pages\admin\ClientsPage.tsx` |
| `2386a64be411` | 2 | 01-api | `.revokestalependinginvitation()` | 2 | 25 | 25 | **no** | — | `apps\api\src\auth\clerk-provisioning.service.ts` |
| `141f8c9da304` | CleanUp3 | 02-web | `apigetmock` | 6 | 5 | 25 | yes | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.virtualize.test.tsx` |
| `743c93a10a45` | CleanUp3 | 02-web | `brief()` | 2 | 25 | 25 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `8aea22946929` | 1 | 02-web | `colorfortype()` | 2 | 25 | 25 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `69da29845d62` | CleanUp3 | 01-api | `component` | 6 | 5 | 25 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\o1\o1-extractor-v1.spec.ts` |
| `27c39d67677e` | CleanUp3 | 02-web | `composerprobe()` | 2 | 25 | 25 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `98fa50e9a7cc` | CleanUp3 | 01-api | `ctx` | 6 | 5 | 25 | **no** | — | `apps\api\scripts\outreach-v3-phase3-live-eval.ts` |
| `4e5ce96ffa01` | CleanUp3 | 02-web | `detailpayload()` | 2 | 25 | 25 | yes | — | `apps\web\src\pages\program-element\ProgramElementWatchPage.test.tsx` |
| `12e03cffca18` | CleanUp3 | 01-api | `directcandidate()` | 2 | 25 | 25 | **no** | **yes** | `apps\api\src\defense-budget\governed-acceptance\candidate-correction\phase10b35c-candidate-correction-e2e.integration.spec.ts` |
| `41d029725e85` | CleanUp3 | 02-web | `map_response` | 2 | 25 | 25 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusPage.test.tsx` |
| `6557aef3964d` | 2 | 02-web | `partybars()` | 2 | 25 | 25 | **no** | — | `apps\web\src\pages\bills\BillPathVotesTab.tsx` |
| `0860b2d7e7c9` | 1 | 02-web | `record()` | 6 | 5 | 25 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `470cac1a965d` | CleanUp3 | 01-api | `target()` | 2 | 25 | 25 | **no** | — | `apps\api\src\outreach-v3\generation\outreach-v3-full-generation-submit.spec.ts` |
| `1aa63d5209b9` | 2 | 04-meri | `walk()` | 2 | 25 | 25 | **no** | — | `packages\meriv2-core\src\evaluation\contract.ts` |
| `482254132992` | 2 | 01-api | `.audit()` | 2 | 24 | 24 | **no** | — | `apps\api\src\meri\meri-firm-skills.service.ts` |
| `0b5e445d02c6` | 1 | 01-api | `.canactivate()` | 5 | 6 | 24 | yes | — | `apps\api\src\business-development\bizdev-watch.flag.guard.ts` |
| `46f773110acb` | 3 | 03-defense | `_component()` | 4 | 8 | 24 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `b16a2d483d55` | 3 | 03-defense | `_first_code()` | 4 | 8 | 24 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `1c594cbd3c0d` | 3 | 03-defense | `_heading_candidates()` | 4 | 8 | 24 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `ac2d59b51395` | 3 | 03-defense | `_package_scope()` | 2 | 24 | 24 | **no** | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `7213e63b1af5` | 3 | 03-defense | `_table_context()` | 4 | 8 | 24 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `a99694a74f9b` | CleanUp3 | 02-web | `apigetmock` | 3 | 12 | 24 | **no** | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.test.tsx` |
| `e0acbcf9d971` | CleanUp3 | 02-web | `at_large_district` | 2 | 24 | 24 | yes | — | `apps\web\src\pages\directory\DistrictDetailView.test.tsx` |
| `209ec7d165c1` | 1 | 06-intel | `boundederror()` | 5 | 6 | 24 | yes | — | `apps\intel-api\src\hearing\capture\ffmpeg-deepgram-capture.runtime.ts` |
| `564ed9f8d007` | 1 | 01-api | `compare()` | 9 | 3 | 24 | yes | — | `apps\api\src\capabilities\context\outreach-context.contract.ts` |
| `041e9714965f` | CleanUp3 | 04-meri | `ctx` | 5 | 6 | 24 | **no** | — | `packages\meriv2-core\src\compliance\action-approval.spec.ts` |
| `3c23c4beb917` | CleanUp3 | 04-meri | `envelope` | 3 | 12 | 24 | **no** | — | `packages\meriv2-core\src\jev\bd-signal-question.spec.ts` |
| `e9973533c3f2` | 2 | 01-api | `fail()` | 7 | 4 | 24 | **no** | — | `apps\api\scripts\pe-budget-phase7-drain-rehearsal.ts` |
| `e1829f956bb7` | 1 | 01-api | `hasflag()` | 9 | 3 | 24 | yes | — | `apps\api\scripts\enrich-award-pe-tas.ts` |
| `e995b9f36ae0` | CleanUp3 | 01-api | `localpostgresconfig` | 4 | 8 | 24 | yes | — | `apps\api\src\meri\meri-research-child-task.pg.spec.ts` |
| `80ebc19526f4` | CleanUp3 | 05-strategy | `memberdetail()` | 2 | 24 | 24 | **no** | — | `apps\api-strategy\src\reports\report-narrative-evidence.spec.ts` |
| `dc4ff3d8809c` | CleanUp3 | 01-api | `procurement` | 5 | 6 | 24 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `2d5481a85650` | CleanUp3 | 01-api | `queuedfetch()` | 3 | 12 | 24 | yes | — | `apps\api\src\directory\legistorm\legistorm-client.spec.ts` |
| `6f0a1e0606c1` | 1 | 08-platform | `read()` | 4 | 8 | 24 | yes | — | `scripts\verify-phase8-session11.mjs` |
| `7a231323cc9d` | CleanUp3 | 02-web | `rendersurface()` | 3 | 12 | 24 | yes | — | `apps\web\src\pages\clients\tracker\TrackerTab.boardviews.test.tsx` |
| `1c7c7d037bc5` | 1 | 08-platform | `run()` | 4 | 8 | 24 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `26b94cd865f9` | 1 | 08-platform | `skiptests` | 4 | 8 | 24 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `7106c9337955` | 1 | 01-api | `sleep()` | 9 | 3 | 24 | yes | — | `apps\api\scripts\backfill-assistance-awards-bulk.ts` |
| `4ee9cff9446f` | 2 | 08-platform | `target` | 9 | 3 | 24 | **no** | — | `scripts\verify-phase8-session10-db.mjs` |
| `e0b24a34aae4` | 2 | 01-api | `mapnarrativetype()` | 2 | 23 | 23 | **no** | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-artifact-builder-v1.ts` |
| `b0aecd51356a` | CleanUp3 | 02-web | `mount()` | 2 | 23 | 23 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `1d2edbd33095` | CleanUp3 | 01-api | `recordingrepository` | 2 | 23 | 23 | **no** | **yes** | `apps\api\src\defense-budget\verification\services\budget-verification-v1.service.cycle-identity.spec.ts` |
| `8c10abbe4387` | CleanUp3 | 02-web | `target()` | 2 | 23 | 23 | **no** | — | `apps\web\src\vnext\pages\engagement\outreach-step-drafts.test.tsx` |
| `ee7878ad6ab3` | 2 | 02-web | `toolbtn()` | 2 | 23 | 23 | **no** | — | `apps\web\src\pages\engagement\outreach\v2\RichTextEditor.tsx` |
| `e3be00473557` | 1 | 01-api | `.audit()` | 2 | 22 | 22 | yes | — | `apps\api\src\business-development\bizdev-watch.service.ts` |
| `a38620fdaa33` | CleanUp3 | 01-api | `api_root` | 2 | 22 | 22 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `6cbd29206165` | CleanUp3 | 02-web | `apigetmock` | 3 | 11 | 22 | **no** | — | `apps\web\src\pages\actions\ActionBoardPage.test.tsx` |
| `bcd9be782f36` | CleanUp3 | 02-web | `apipostmock` | 3 | 11 | 22 | **no** | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.test.tsx` |
| `dbba1e67f626` | 1 | 02-web | `buildmarkrows()` | 2 | 22 | 22 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `74be3be61620` | CleanUp3 | 01-api | `candidateref()` | 2 | 22 | 22 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `a248a2f76486` | CleanUp3 | 08-platform | `cdk_root` | 3 | 11 | 22 | **no** | — | `infra\cdk\test\engagement-api-least-privilege.spec.ts` |
| `0449e9e1b585` | CleanUp3 | 02-web | `controlledstream()` | 2 | 22 | 22 | yes | — | `apps\web\src\components\chat\useMeriChatController.prospect-launch.test.tsx` |
| `0549ac17e2ef` | CleanUp3 | 01-api | `makemanifestdoc()` | 2 | 22 | 22 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-cycle-pipeline-v1.spec.ts` |
| `78bfde451bfb` | CleanUp3 | 01-api | `makepage()` | 3 | 11 | 22 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\o1\o1-extractor-v1.spec.ts` |
| `eec02103b611` | 2 | 02-web | `miniava()` | 2 | 22 | 22 | **no** | — | `apps\web\src\pages\workspace\ContextBuilderPage.tsx` |
| `59c851e61f21` | 1 | 02-web | `months` | 3 | 11 | 22 | yes | — | `apps\web\src\vnext\pages\strategies\context\ContextDocumentVNext.tsx` |
| `2d5826c5e83d` | CleanUp3 | 02-web | `now` | 2 | 22 | 22 | yes | — | `apps\web\src\vnext\pages\strategies\StrategyEditorVNext.dirty-guard.test.tsx` |
| `418272232422` | 2 | 02-web | `pelinkbasis()` | 2 | 22 | 22 | **no** | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `c3a93d760cc8` | 1 | 02-web | `promptfor()` | 2 | 22 | 22 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `d7208ca8947e` | 1 | 01-api | `referencecolumns()` | 2 | 22 | 22 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `2cdcfe23b539` | CleanUp3 | 02-web | `renderdrawer()` | 2 | 22 | 22 | yes | — | `apps\web\src\pages\clients\tracker\MemoComposerDrawer.feedback.test.tsx` |
| `0a0a4132cec8` | CleanUp3 | 02-web | `row` | 2 | 22 | 22 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.test.tsx` |
| `4139f212b04f` | CleanUp3 | 04-meri | `source()` | 2 | 22 | 22 | **no** | — | `packages\meriv2-core\src\jev\bd-signal-question.spec.ts` |
| `350d7782fb55` | CleanUp3 | 04-meri | `source()` | 2 | 22 | 22 | **no** | — | `packages\meriv2-core\src\jev\bd-entity-question.spec.ts` |
| `83d554faca5d` | 1 | 02-web | `.once()` | 2 | 21 | 21 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `5ed7b8277fab` | CleanUp3 | 01-api | `.readextractionartifactlocator()` | 4 | 7 | 21 | yes | **yes** | `apps\api\scripts\replace-defense-budget-candidate-approvals-v1.integration.spec.ts` |
| `6082b7e70807` | 1 | 02-web | `.send()` | 4 | 7 | 21 | yes | — | `apps\web\scripts\engagement-phase3-browser-interactions.mjs` |
| `a1ce211b90ef` | 1 | 01-api | `.verifystate()` | 2 | 21 | 21 | yes | — | `apps\api\src\engagement\google\google-oauth.service.ts` |
| `abfbf474f37c` | 3 | 03-defense | `_label_column_index()` | 4 | 7 | 21 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `c36585b77943` | 3 | 03-defense | `_package_action_candidate()` | 2 | 21 | 21 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `5670b3bd8ac9` | 3 | 03-defense | `_row_semantic()` | 2 | 21 | 21 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `cd8e47b316ac` | CleanUp3 | 02-web | `apigetmock` | 4 | 7 | 21 | yes | — | `apps\web\src\pages\clients\tracker\DistrictBriefComposerDrawer.held.test.tsx` |
| `cf6bbe02c087` | CleanUp3 | 01-api | `billrec()` | 2 | 21 | 21 | yes | — | `apps\api\src\clients\client-capability-fit.normalize.spec.ts` |
| `a1f2b979311e` | 1 | 08-platform | `children` | 2 | 21 | 21 | yes | — | `scripts\run-engagement-phase1-local.mjs` |
| `b6ab9c129afa` | CleanUp3 | 01-api | `ctxa` | 4 | 7 | 21 | **no** | — | `apps\api\src\live-hearings\legiwatch-wave1-pg.integration.spec.ts` |
| `a4d684163e7a` | CleanUp3 | 01-api | `ctxb` | 4 | 7 | 21 | **no** | — | `apps\api\src\live-hearings\legiwatch-wave1-pg.integration.spec.ts` |
| `af39d0446ba3` | 1 | 08-platform | `diffrows()` | 2 | 21 | 21 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `81f101e27a20` | 1 | 02-web | `evidencelinks()` | 2 | 21 | 21 | yes | — | `apps\web\src\pages\program-element\ProgramMatchQueuePage.tsx` |
| `a174818fb96c` | 1 | 02-web | `logo_domain` | 2 | 21 | 21 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `8f04949963c7` | CleanUp3 | 01-api | `makecell()` | 8 | 3 | 21 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.spec.ts` |
| `10387564eaac` | CleanUp3 | 02-web | `makesession()` | 2 | 21 | 21 | **no** | — | `apps\web\src\vnext\pages\engagement\outreach-step-context.test.tsx` |
| `a70e8cb0c11e` | 1 | 01-api | `mapwithconcurrency()` | 2 | 21 | 21 | yes | — | `apps\api\src\engagement\engagement.service.ts` |
| `28884e122ead` | 1 | 02-web | `mediaplayer()` | 2 | 21 | 21 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `f27c3872bce7` | CleanUp3 | 05-strategy | `packagetext()` | 2 | 21 | 21 | yes | — | `apps\api-strategy\src\reports\report-amendment.spec.ts` |
| `2842630dc27e` | 1 | 01-api | `rateof()` | 2 | 21 | 21 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `745e71f1445e` | CleanUp3 | 01-api | `repo_root` | 2 | 21 | 21 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `a44faa7dd69e` | 1 | 01-api | `resolvepnpm()` | 2 | 21 | 21 | yes | — | `apps\api\scripts\non-rdte-phase5-operator-contract.spec.ts` |
| `16729bc52e47` | 1 | 02-web | `totimelineevent()` | 2 | 21 | 21 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `a4e8f07c4be5` | 1 | 02-web | `viewmode` | 2 | 21 | 21 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `5fe2518115bc` | CleanUp3 | 02-web | `apipatchmock` | 3 | 10 | 20 | **no** | — | `apps\web\src\pages\actions\ActionBoardPage.test.tsx` |
| `06a5754891f2` | 1 | 02-web | `buildlanes()` | 2 | 20 | 20 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `2ef391f302fb` | 1 | 02-web | `contact_use_tag_color` | 3 | 10 | 20 | yes | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `0434416eeebf` | CleanUp3 | 05-strategy | `daysfromtoday()` | 5 | 5 | 20 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `6d27b527eded` | CleanUp3 | 02-web | `detail` | 2 | 20 | 20 | **no** | — | `apps\web\src\vnext\pages\strategies\StrategyEditorVNext.dirty-guard.test.tsx` |
| `9c0e48987c7a` | 1 | 01-api | `dispositionforrole()` | 2 | 20 | 20 | yes | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.ts` |
| `4752f9d4a5b0` | CleanUp3 | 01-api | `entity()` | 2 | 20 | 20 | yes | — | `apps\api\src\funding-opportunities\client-profile-enrichment.service.spec.ts` |
| `f1d0698a9283` | 1 | 02-web | `extractyoutubevideoid()` | 2 | 20 | 20 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `6b92678145b4` | CleanUp3 | 08-platform | `fixture` | 3 | 10 | 20 | **no** | — | `infra\cdk\test\engagement-api-least-privilege.spec.ts` |
| `675892ee0fc8` | CleanUp3 | 02-web | `getmock` | 6 | 4 | 20 | **no** | — | `apps\web\src\components\chat\WorkPerformed.test.tsx` |
| `a9b013fb2cb3` | 1 | 01-api | `ismemorysection()` | 3 | 10 | 20 | yes | — | `apps\api\src\memory\governed-memory-candidate.service.ts` |
| `db9cfdd1b69c` | 1 | 01-api | `nextpageof()` | 3 | 10 | 20 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `46aefcea2eab` | CleanUp3 | 05-strategy | `node()` | 2 | 20 | 20 | **no** | — | `apps\api-strategy\src\reports\report-narrative-evidence.spec.ts` |
| `4fc60583d140` | 1 | 02-web | `numbervalue()` | 3 | 10 | 20 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `fc9d28aad85f` | 2 | 01-api | `ok()` | 6 | 4 | 20 | **no** | — | `apps\api\scripts\pe-budget-phase7-drain-rehearsal.ts` |
| `bce5cd1cac8e` | 1 | 01-api | `parseargs()` | 2 | 20 | 20 | yes | — | `apps\api\scripts\sync-tango-dibbs.ts` |
| `2cb1c7c73f5c` | CleanUp3 | 01-api | `parses()` | 3 | 10 | 20 | yes | — | `apps\api\scripts\accept-defense-budget-ingestion-review-entrypoint.spec.ts` |
| `5a9999913209` | CleanUp3 | 02-web | `payload` | 2 | 20 | 20 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `7cc9b44622af` | CleanUp3 | 01-api | `positionrow()` | 2 | 20 | 20 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\sacd\sacd-composer-v1.spec.ts` |
| `ef38d68d0814` | CleanUp3 | 01-api | `readapi()` | 2 | 20 | 20 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `5d44cad94d5c` | 1 | 01-api | `resolvepnpm()` | 2 | 20 | 20 | yes | — | `apps\api\scripts\verify-pe-budget-phase-4-closeout.ts` |
| `f44c7f533981` | 1 | 08-platform | `resolvereporoot()` | 3 | 10 | 20 | yes | — | `scripts\verify-phase8-session10.mjs` |
| `9d1209b5ce49` | 1 | 02-web | `sels` | 3 | 10 | 20 | yes | — | `apps\web\src\pages\strategy\StrategyLibraryPage.tsx` |
| `4181fd4d0fb4` | 1 | 02-web | `serverrow` | 2 | 20 | 20 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `d3243fa98803` | CleanUp3 | 01-api | `servicewith()` | 3 | 10 | 20 | yes | — | `apps\api\src\engagement\engagement-audiences.spec.ts` |
| `9f939fff2e5a` | CleanUp3 | 01-api | `sqltext()` | 5 | 5 | 20 | yes | — | `apps\api\src\memory\exact-memory-cleanup-outbox.service.spec.ts` |
| `9904bf5d1e2c` | 1 | 01-api | `.resolvekgtraversalsource()` | 2 | 19 | 19 | yes | — | `apps\api\src\memory\memory-fk-loader.service.ts` |
| `e594380edc1c` | 1 | 05-strategy | `.stampmetrics()` | 2 | 19 | 19 | yes | — | `apps\api-strategy\src\agents\execution.service.ts` |
| `8b6c53511ddc` | CleanUp3 | 02-web | `candidaterow()` | 2 | 19 | 19 | yes | — | `apps\web\src\pages\program-element\ProgramMatchQueuePage.test.tsx` |
| `cd63ef93b4d3` | 1 | 02-web | `catalogentry` | 2 | 19 | 19 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `46fabc546399` | 1 | 07-workspace-onboard | `foreachbounded()` | 2 | 19 | 19 | yes | — | `apps\workspace\src\generation\generation.service.ts` |
| `02263123af33` | 1 | 02-web | `handlerowclick()` | 2 | 19 | 19 | yes | — | `apps\web\src\pages\intelligence\ChangesInboxPage.tsx` |
| `3218c14c24ed` | CleanUp3 | 02-web | `mockroutes()` | 2 | 19 | 19 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.capabilities.test.tsx` |
| `35b9853561ce` | 1 | 01-api | `personnelwriterlike` | 2 | 19 | 19 | yes | — | `apps\api\src\acquisition-personnel\importers\dow-directory-v6-importer.ts` |
| `5b68d51d7f60` | CleanUp3 | 01-api | `positionrow()` | 2 | 19 | 19 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `2fd0769634be` | 2 | 02-web | `profilekpi()` | 2 | 19 | 19 | **no** | — | `apps\web\src\pages\program-element\ProgramElementProfileFinalPage.tsx` |
| `4c66fb647304` | CleanUp3 | 01-api | `projectionplanrow()` | 2 | 19 | 19 | yes | **yes** | `apps\api\src\defense-budget\promotion\eligibility-bound-projection-source-prisma-v1.spec.ts` |
| `4b50992af466` | CleanUp3 | 02-web | `review()` | 2 | 19 | 19 | yes | — | `apps\web\src\pages\reviews\ReviewQueuePage.test.tsx` |
| `947e70b7c054` | 2 | 04-meri | `.fetchtoolschemas()` | 2 | 18 | 18 | **no** | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.ts` |
| `4b0fd2766097` | CleanUp3 | 08-platform | `allstatements()` | 2 | 18 | 18 | yes | — | `infra\cdk\test\engagement-api-active-promotion.spec.ts` |
| `9704681173ce` | CleanUp3 | 02-web | `apigetmock` | 4 | 6 | 18 | **no** | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.test.tsx` |
| `aba9303a13bd` | CleanUp3 | 02-web | `apipatchmock` | 4 | 6 | 18 | yes | — | `apps\web\src\pages\clients\tracker\DistrictBriefComposerDrawer.held.test.tsx` |
| `768a575e5285` | CleanUp3 | 02-web | `apipostmock` | 3 | 9 | 18 | **no** | — | `apps\web\src\pages\actions\ActionBoardPage.test.tsx` |
| `3f5dbfa149b8` | 1 | 08-platform | `app` | 3 | 9 | 18 | yes | — | `infra\cdk\bin\defense-budget-annual-operations.ts` |
| `c0c5be4eafe7` | CleanUp3 | 02-web | `audit_response` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `5c4be8c3affc` | CleanUp3 | 08-platform | `base()` | 4 | 6 | 18 | yes | — | `infra\cdk\test\engagement-api-active-promotion.spec.ts` |
| `43bc7d7f8a06` | 3 | 03-defense | `boundingboxv1` | 3 | 9 | 18 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\contracts.py` |
| `7f4a38de1d23` | 1 | 02-web | `brandingresponse` | 3 | 9 | 18 | yes | — | `apps\web\src\components\AppShell.tsx` |
| `d1473287fa21` | 1 | 01-api | `comparestrings()` | 7 | 3 | 18 | yes | **yes** | `apps\api\src\defense-budget\contracts\artifact-builders.ts` |
| `61cf7034dad7` | 1 | 02-web | `conus_bounds` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusMap.tsx` |
| `d80933b331d9` | CleanUp3 | 02-web | `css_path` | 3 | 9 | 18 | **no** | — | `apps\web\src\vnext\pages\district-nexus\district-nexus-layout.contract.test.ts` |
| `bf6fd189131a` | CleanUp3 | 01-api | `ctx` | 4 | 6 | 18 | **no** | — | `apps\api\src\intelligence\alert-memo\approved-hearing-recap.spec.ts` |
| `6856fcc61819` | CleanUp3 | 04-meri | `ctx` | 4 | 6 | 18 | yes | — | `apps\meriv2-orchestrator\src\meri\steward\context-import.service.spec.ts` |
| `16ed38555768` | CleanUp3 | 01-api | `ctxfor()` | 4 | 6 | 18 | yes | — | `apps\api\src\defense-budget-lifecycle\defense-budget-lifecycle-internal.guard.spec.ts` |
| `4671865469eb` | 1 | 02-web | `deadlinecountdown()` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\program-element\ProcurementActivityPanel.tsx` |
| `6ab6c623026a` | CleanUp3 | 02-web | `district()` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusTable.test.tsx` |
| `efe403f7da2e` | CleanUp3 | 02-web | `district()` | 2 | 18 | 18 | **no** | — | `apps\web\src\vnext\components\district-map\DistrictNexusMapLibre.test.tsx` |
| `1dc7b6b17761` | 1 | 02-web | `districtcontextfor()` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `112cb7f9d7e6` | 1 | 01-api | `extractfiscalyear()` | 2 | 18 | 18 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-extractor-v1.ts` |
| `9b88ae0b9f7d` | 1 | 02-web | `historysearchresult` | 3 | 9 | 18 | yes | — | `apps\web\src\components\chat\SessionRail.tsx` |
| `52dbf7f9b34b` | CleanUp3 | 01-api | `makepage()` | 2 | 18 | 18 | yes | **yes** | `apps\api\src\defense-budget\rdte\r3\r3-extractor-v1.spec.ts` |
| `bb2652510cd7` | 1 | 02-web | `markfield` | 2 | 18 | 18 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `a9cb32a779e2` | 1 | 01-api | `nonblank` | 7 | 3 | 18 | yes | **yes** | `apps\api\src\defense-budget\phase6\phase6-cycle-certification-v1.ts` |
| `39d909e0200d` | 1 | 01-api | `numarg()` | 4 | 6 | 18 | yes | — | `apps\api\scripts\reconcile-person-role-staleness.ts` |
| `c65675a0cff6` | CleanUp3 | 01-api | `prismadouble` | 2 | 18 | 18 | **no** | — | `apps\api\scripts\diag-funding-opportunities-makegov.spec.ts` |
| `859a353487f1` | 1 | 08-platform | `privatesubnetids` | 3 | 9 | 18 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `222ea3a19cc5` | CleanUp3 | 01-api | `productionfiles()` | 2 | 18 | 18 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-phase5-architecture.spec.ts` |
| `20b396a29b82` | CleanUp3 | 01-api | `recordingaudit` | 4 | 6 | 18 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-service-v1.spec.ts` |
| `1b72b4a1c67e` | 1 | 08-platform | `require` | 4 | 6 | 18 | yes | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `7b60829cdd8a` | 1 | 08-platform | `results` | 4 | 6 | 18 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `966df285cead` | CleanUp3 | 01-api | `runtimepolicy` | 3 | 9 | 18 | yes | — | `apps\api\src\engagement\engagement-sync-scheduler.service.spec.ts` |
| `75b329ed98c4` | 1 | 02-web | `sentence()` | 7 | 3 | 18 | yes | — | `apps\web\src\pages\engagement\outreach\v3\ContextReviewSurface.tsx` |
| `27fef1e759c7` | 1 | 02-web | `stringvalue()` | 4 | 6 | 18 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `e5ab11aba7db` | CleanUp3 | 01-api | `stripcomments()` | 7 | 3 | 18 | yes | **yes** | `apps\api\src\defense-budget\contracts\contract-containment.spec.ts` |
| `6472bca99e58` | 1 | 08-platform | `tables` | 2 | 18 | 18 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `41b646367da4` | 2 | 08-platform | `terminate()` | 2 | 18 | 18 | **no** | — | `scripts\run-engagement-phase1-local.mjs` |
| `c3ddfc9e4cda` | 1 | 02-web | `titlecase()` | 4 | 6 | 18 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsPhase7Surface.tsx` |
| `9e02457b42fa` | 1 | 01-api | `uniquedomains()` | 7 | 3 | 18 | yes | — | `apps\api\src\clients\client-profile-fill-context-plane.service.ts` |
| `549135b33db8` | 2 | 01-api | `.capabilitycontext()` | 2 | 17 | 17 | **no** | — | `apps\api\src\outreach-v3\context\outreach-v3-context.service.ts` |
| `19440a7d48f7` | 1 | 04-meri | `.meterround()` | 2 | 17 | 17 | yes | — | `apps\meriv2-orchestrator\src\meri\steward\steward-extract.service.ts` |
| `8d01333f20b8` | CleanUp3 | 01-api | `.persistcompletedverification()` | 2 | 17 | 17 | **no** | **yes** | `apps\api\src\defense-budget\verification\services\budget-verification-v1.service.cycle-identity.spec.ts` |
| `d10b486c5c4e` | 3 | 03-defense | `_line_family()` | 2 | 17 | 17 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hasc\semantics.py` |
| `a327822c693b` | CleanUp3 | 02-web | `acceptedref()` | 2 | 17 | 17 | yes | — | `apps\web\src\vnext\pages\engagement\outreach-step-context.test.tsx` |
| `db1fe77be106` | CleanUp3 | 02-web | `apiget` | 18 | 1 | 17 | yes | — | `apps\web\src\vnext\pages\legiwatch\bills\bill-360-drawer-kpis.test.tsx` |
| `93ad671b32ce` | CleanUp3 | 02-web | `basememoresult()` | 2 | 17 | 17 | yes | — | `apps\web\src\pages\clients\tracker\MemoComposerDrawer.held.test.tsx` |
| `aa57c10e7616` | CleanUp3 | 04-meri | `build()` | 2 | 17 | 17 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy-assistant.service.spec.ts` |
| `6bc688302011` | 1 | 08-platform | `clerkorgid` | 2 | 17 | 17 | yes | — | `scripts\run-engagement-phase1-local.mjs` |
| `2f3b7ba37df0` | 2 | 02-web | `closeglyph()` | 2 | 17 | 17 | **no** | — | `apps\web\src\vnext\pages\strategies\overlays\FirmPhasesOverlay.tsx` |
| `49a09de4b7a1` | CleanUp3 | 01-api | `committee()` | 2 | 17 | 17 | yes | — | `apps\api\src\directory\directory-detail.spec.ts` |
| `dccfb6e812db` | CleanUp3 | 02-web | `feedof()` | 2 | 17 | 17 | yes | — | `apps\web\src\vnext\pages\legiwatch\feed\feed-band-labels.test.tsx` |
| `6a881d363286` | CleanUp3 | 01-api | `harness()` | 2 | 17 | 17 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `549c82523017` | CleanUp3 | 01-api | `ledger()` | 2 | 17 | 17 | yes | — | `apps\api\scripts\sync-tango-dibbs.spec.ts` |
| `d8d061ac8a02` | CleanUp3 | 02-web | `makeprefs()` | 2 | 17 | 17 | yes | — | `apps\web\src\pages\clients\tracker\TrackerConfigPanel.email.test.tsx` |
| `08fbe0127fab` | 1 | 01-api | `mapentity()` | 2 | 17 | 17 | yes | — | `apps\api\src\knowledge\entities\canonical-entity-registration.repository.ts` |
| `e621392f9b9c` | CleanUp3 | 02-web | `me` | 2 | 17 | 17 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.capabilities.test.tsx` |
| `a20b42d8b376` | 2 | 02-web | `memberrow()` | 2 | 17 | 17 | **no** | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `4dcc837fef2e` | CleanUp3 | 02-web | `mount()` | 2 | 17 | 17 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioGovernedInteractions.test.tsx` |
| `56897fd8c961` | 1 | 01-api | `prismaservicefromclient()` | 2 | 17 | 17 | yes | — | `apps\api\scripts\backfill-canonical-entities.ts` |
| `81f14aaf8af9` | 1 | 01-api | `requiredisposableurl()` | 2 | 17 | 17 | yes | — | `apps\api\scripts\verify-memory-phase2-notification-closeout.ts` |
| `078394e3afb0` | 1 | 08-platform | `runcli()` | 2 | 17 | 17 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `29c2bcb337c7` | 2 | 02-web | `sourcelogo()` | 2 | 17 | 17 | **no** | — | `apps\web\src\pages\explorer\DataExplorerPage.tsx` |
| `998127b635c2` | 1 | 02-web | `stylesheet` | 2 | 17 | 17 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `15916c59195e` | CleanUp3 | 02-web | `summary` | 2 | 17 | 17 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.test.tsx` |
| `6a9e16413cdd` | 1 | 01-api | `.canactivate()` | 5 | 4 | 16 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-context.guard.ts` |
| `49031080c18c` | 1 | 01-api | `.onmoduledestroy()` | 5 | 4 | 16 | yes | — | `apps\api\src\engagement-workers\meeting-prep-worker.service.ts` |
| `6969490729f4` | 3 | 03-defense | `_fiscal_year()` | 3 | 8 | 16 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `f0c98abf8685` | 3 | 03-defense | `_normalize_text()` | 5 | 4 | 16 | **no** | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `b805dbc85d7d` | CleanUp3 | 02-web | `aliases` | 2 | 16 | 16 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `db22b55e9af6` | CleanUp3 | 02-web | `apigetmock` | 3 | 8 | 16 | **no** | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.test.tsx` |
| `7e291441ba50` | CleanUp3 | 01-api | `apiroot()` | 5 | 4 | 16 | yes | — | `apps\api\scripts\lib\pe-production-scripts.spec.ts` |
| `b79e8c1e2091` | 1 | 01-api | `argvalue()` | 5 | 4 | 16 | yes | — | `apps\api\scripts\accept-defense-budget-ingestion-review-v1.ts` |
| `6c3442f085d1` | 1 | 02-web | `artifact_type_order` | 2 | 16 | 16 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `a06522895efc` | 1 | 08-platform | `cfg` | 3 | 8 | 16 | yes | — | `infra\cdk\bin\defense-budget-annual-operations.ts` |
| `c6da6766edfe` | 1 | 01-api | `check()` | 5 | 4 | 16 | yes | — | `apps\api\scripts\pe-budget-phase7-drain-rehearsal.ts` |
| `bcffb37dd682` | 1 | 08-platform | `checkvocabulary()` | 2 | 16 | 16 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `7f0aead72735` | 1 | 01-api | `commit` | 3 | 8 | 16 | yes | — | `apps\api\scripts\reconcile-person-role-staleness.ts` |
| `36ab23eb6b25` | 1 | 01-api | `compatibilitysourcestatus()` | 3 | 8 | 16 | yes | — | `apps\api\src\context\strategy-context-plane.service.ts` |
| `de7be060766b` | CleanUp3 | 01-api | `context()` | 2 | 16 | 16 | **no** | **yes** | `apps\api\src\defense-budget\stages\authorization\hasc-verification-wiring.spec.ts` |
| `c01a86eae24f` | CleanUp3 | 01-api | `ctx` | 5 | 4 | 16 | **no** | — | `apps\api\src\clients\client-people.import.spec.ts` |
| `46da0e506def` | 1 | 02-web | `emptybox` | 3 | 8 | 16 | yes | — | `apps\web\src\pages\strategy\agents\ExecutionReview.tsx` |
| `50aa89756b3e` | 1 | 02-web | `fmtday()` | 3 | 8 | 16 | yes | — | `apps\web\src\vnext\pages\strategies\context\ContextDocumentVNext.tsx` |
| `88fe5ddf426e` | 1 | 01-api | `fundingstagetofield()` | 2 | 16 | 16 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\o1\o1-extractor-v1.ts` |
| `84907b773070` | CleanUp3 | 02-web | `guidanceref()` | 2 | 16 | 16 | yes | — | `apps\web\src\vnext\pages\engagement\outreach-builder-model.test.ts` |
| `6b96f82ad689` | 1 | 01-api | `isuniqueviolation()` | 3 | 8 | 16 | yes | — | `apps\api\src\evaluation\evaluation-capture.service.ts` |
| `3ab92a28cd21` | CleanUp3 | 02-web | `locationprobe()` | 5 | 4 | 16 | **no** | — | `apps\web\src\vnext\pages\client-crm\ClientCrmPage.test.tsx` |
| `3e0ca7ff3e39` | CleanUp3 | 01-api | `makecheck()` | 2 | 16 | 16 | **no** | **yes** | `apps\api\src\defense-budget\verification\decision\decision.spec.ts` |
| `6334c575091e` | 1 | 02-web | `membername()` | 3 | 8 | 16 | yes | — | `apps\web\src\pages\strategy\members.ts` |
| `b5f7090c4169` | 1 | 02-web | `mintsignintoken()` | 2 | 16 | 16 | yes | — | `apps\web\scripts\engagement-phase3-browser-interactions.mjs` |
| `90ada85460c5` | 1 | 02-web | `mintticket()` | 2 | 16 | 16 | yes | — | `apps\web\scripts\engagement-phase3-browser-recovery.mjs` |
| `252f809db8fe` | CleanUp3 | 01-api | `passingcheck()` | 2 | 16 | 16 | yes | **yes** | `apps\api\src\defense-budget\governed-acceptance\defense-budget-ingestion-outbox-review-acceptance-v1.spec.ts` |
| `7ddbf276cb18` | CleanUp3 | 04-meri | `provider()` | 3 | 8 | 16 | **no** | — | `packages\meriv2-core\src\jev\bd-entity-question.spec.ts` |
| `203587f57899` | CleanUp3 | 02-web | `renderwithclient()` | 3 | 8 | 16 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `1a127904940f` | 1 | 03-defense | `require` | 2 | 16 | 16 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `d8781b73d310` | 1 | 01-api | `securityenvelope` | 5 | 4 | 16 | yes | — | `apps\api\src\context\meetings-context-plane.runtime.ts` |
| `81a197810e2e` | CleanUp3 | 05-strategy | `seedmission()` | 2 | 16 | 16 | yes | — | `apps\api-strategy\src\agents\watch-review.service.spec.ts` |
| `9b791f2e252b` | 1 | 01-api | `slugify()` | 3 | 8 | 16 | yes | — | `apps\api\scripts\normalize-state-committees.ts` |
| `a146190f1bb1` | 1 | 02-web | `sourcecitation()` | 2 | 16 | 16 | yes | — | `apps\web\src\pages\bills\BillFundingTab.tsx` |
| `4cff510bd917` | 1 | 02-web | `uploadclientdocument()` | 2 | 16 | 16 | yes | — | `apps\web\src\pages\admin\ClientsPage.tsx` |
| `d11a31c52368` | 1 | 02-web | `usecontexthealth()` | 2 | 16 | 16 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `7f5a86bca6bb` | 1 | 01-api | `.markaccepted()` | 2 | 15 | 15 | yes | — | `apps\api\src\clients\client-profile-fill-completion.service.ts` |
| `96ec6081a71e` | 2 | 01-api | `.marksyncerror()` | 2 | 15 | 15 | **no** | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `5a1d24a96367` | 1 | 03-defense | `__dirname` | 2 | 15 | 15 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `f112604bee7d` | 1 | 08-platform | `__dirname` | 4 | 5 | 15 | yes | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `819f90fb4e7a` | 3 | 03-defense | `_is_quantity_header()` | 4 | 5 | 15 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `859fa414d2bc` | 3 | 03-defense | `_match_group()` | 4 | 5 | 15 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `a7426cc779e4` | CleanUp3 | 02-web | `apipostmock` | 4 | 5 | 15 | yes | — | `apps\web\src\pages\clients\tracker\DistrictBriefComposerDrawer.held.test.tsx` |
| `7d99d2449648` | CleanUp3 | 02-web | `apipostmock` | 4 | 5 | 15 | **no** | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.test.tsx` |
| `a5a4f3c68442` | 1 | 08-platform | `banned_learning_signal_create_symbols` | 2 | 15 | 15 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `b6716efee1ec` | 1 | 01-api | `canonicalentityrow` | 2 | 15 | 15 | yes | — | `apps\api\src\knowledge\entities\canonical-entity-registration.repository.ts` |
| `a55df2524c1c` | 1 | 02-web | `dossierkpi` | 2 | 15 | 15 | yes | — | `apps\web\src\components\dossier\DossierKpiStrip.tsx` |
| `140742a4e4cd` | 2 | 02-web | `dossierkpistrip()` | 2 | 15 | 15 | **no** | — | `apps\web\src\components\dossier\DossierKpiStrip.tsx` |
| `ced73b1efe36` | CleanUp3 | 01-api | `fixturesdir` | 4 | 5 | 15 | yes | — | `apps\api\src\program-element\parsers\armed-services-report-parser.spec.ts` |
| `b109b1e553b1` | 1 | 02-web | `formatdate()` | 4 | 5 | 15 | yes | — | `apps\web\src\pages\directory\DowDirectoryResults.tsx` |
| `4351bcbdfd1c` | 1 | 01-api | `isrecord()` | 6 | 3 | 15 | yes | — | `apps\api\src\live-hearings\phase9\run-legiwatch-phase9-operator.ts` |
| `388fdd308ca6` | 3 | 03-defense | `load_pages()` | 4 | 5 | 15 | yes | — | `apps\defense-budget-parser\tests\test_hacd_stage_extractor.py` |
| `c24c64e0e021` | 1 | 01-api | `loadnest()` | 2 | 15 | 15 | yes | — | `apps\api\scripts\detect-tracker-alerts.ts` |
| `86cbf2304013` | CleanUp3 | 01-api | `makereader()` | 2 | 15 | 15 | yes | **yes** | `apps\api\src\defense-budget\verification\trusted-proof\production-proof-wiring.spec.ts` |
| `a0e644f9de40` | CleanUp3 | 01-api | `matches()` | 2 | 15 | 15 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `72ce3345aa32` | 1 | 04-meri | `priorusertargethint()` | 2 | 15 | 15 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-governed-tool-selection.ts` |
| `ad92d61246d9` | 1 | 01-api | `prismaservicefromclient()` | 6 | 3 | 15 | yes | — | `apps\api\scripts\diag-tango-health.ts` |
| `94c0e0e10fa7` | CleanUp3 | 01-api | `request()` | 2 | 15 | 15 | **no** | — | `apps\api\src\retrieval\adapters\institutional-knowledge-retrieval.adapter.pglite.spec.ts` |
| `f0cc78b9a151` | 2 | 01-api | `required()` | 4 | 5 | 15 | **no** | — | `apps\api\scripts\pe-budget-phase7-drain-rehearsal.ts` |
| `e5a549c0bd15` | CleanUp3 | 02-web | `resizeobservermock` | 4 | 5 | 15 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.test.tsx` |
| `242e904c011f` | 1 | 08-platform | `resolvereporoot()` | 2 | 15 | 15 | yes | — | `scripts\phase8-session4-fy27-replay.mjs` |
| `132e4e42637c` | CleanUp3 | 05-strategy | `seedmission()` | 2 | 15 | 15 | yes | — | `apps\api-strategy\src\agents\missions.service.spec.ts` |
| `4cb5c647bd98` | 1 | 01-api | `tenantrole()` | 4 | 5 | 15 | yes | — | `apps\api\src\memory\memory-review-inbox.service.ts` |
| `6f69ae65efb4` | 1 | 02-web | `usetenantmembers()` | 2 | 15 | 15 | yes | — | `apps\web\src\pages\strategy\members.ts` |
| `4bb1863bca73` | 2 | 08-platform | `waitdatabase()` | 2 | 15 | 15 | **no** | — | `scripts\run-engagement-phase1-local.mjs` |
| `fcfb9b37fd1d` | 1 | 08-platform | `waitforurl()` | 2 | 15 | 15 | yes | — | `scripts\run-engagement-phase0-local.mjs` |
| `52e3b63d1986` | 1 | 08-platform | `waiturl()` | 2 | 15 | 15 | yes | — | `scripts\run-engagement-phase1-post-acceptance.mjs` |
| `bb9b6d713078` | 1 | 02-web | `withtimeout()` | 2 | 15 | 15 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `4601f99bb94a` | 1 | 01-api | `.assertclient()` | 2 | 14 | 14 | yes | — | `apps\api\src\clients\client-profile-fill-completion.service.ts` |
| `a796674d0cf1` | 1 | 01-api | `.currentplan()` | 2 | 14 | 14 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-approval.service.ts` |
| `448d68cc5081` | 1 | 01-api | `.deadletterexhaustedleases()` | 2 | 14 | 14 | yes | — | `apps\api\src\memory\exact-memory-projection-worker.service.ts` |
| `685990e6f972` | 1 | 07-workspace-onboard | `.internaladdresses()` | 2 | 14 | 14 | yes | — | `apps\workspace\src\hillday\hillday-document.service.ts` |
| `4d926d57b394` | 1 | 01-api | `.notifications()` | 2 | 14 | 14 | yes | — | `apps\api\src\engagement\microsoft\microsoft-callbacks.controller.ts` |
| `6256f8449e2f` | 2 | 02-web | `.render()` | 2 | 14 | 14 | **no** | — | `apps\web\src\vnext\pages\client-crm\VNextClientCrmRoute.tsx` |
| `43f5ac26ceea` | 3 | 03-defense | `_column_from_header()` | 2 | 14 | 14 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `0ceeea4d7da6` | 3 | 03-defense | `_normalize_table()` | 3 | 7 | 14 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\extractor.py` |
| `09059f3af95c` | CleanUp3 | 02-web | `apigetmock` | 3 | 7 | 14 | **no** | — | `apps\web\src\pages\program-element\MarkupMonitorPage.test.tsx` |
| `e58d272ba3ea` | CleanUp3 | 02-web | `apigetmock` | 8 | 2 | 14 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusFilters.test.tsx` |
| `1ae1a775f301` | 1 | 03-defense | `approot` | 2 | 14 | 14 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `8eaa43a62b61` | 1 | 02-web | `chevronleftglyph()` | 3 | 7 | 14 | yes | — | `apps\web\src\vnext\pages\strategies\context\ContextDocumentVNext.tsx` |
| `233afe865faa` | 1 | 01-api | `combinestats()` | 2 | 14 | 14 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `64cd3f59bbd8` | CleanUp3 | 01-api | `ctx` | 3 | 7 | 14 | **no** | — | `apps\api\src\meri\meri.service.artifact-image.spec.ts` |
| `33081c652255` | 1 | 02-web | `customerrow` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\admin\CustomersPage.tsx` |
| `88f916042531` | 1 | 02-web | `evidencelabel()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `f30ff2226604` | 1 | 01-api | `fetchwithtimeout()` | 2 | 14 | 14 | yes | — | `apps\api\src\intelligence\artifacts\artifact-generator.service.ts` |
| `b9573b102c86` | 1 | 01-api | `findheaderrow()` | 8 | 2 | 14 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.ts` |
| `62286c7859cd` | 1 | 04-meri | `firststring()` | 3 | 7 | 14 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-retrieval-recipe-utils.ts` |
| `be4a62792509` | 1 | 02-web | `formatdatetime()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `43997a97e9e7` | CleanUp3 | 02-web | `individual()` | 3 | 7 | 14 | yes | — | `apps\web\src\pages\engagement\outreach\v2\generation.test.ts` |
| `107e8f43715f` | 1 | 04-meri | `invokeargs` | 2 | 14 | 14 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-managed-mcp-assistant.service.ts` |
| `087985406695` | CleanUp3 | 01-api | `makesource()` | 2 | 14 | 14 | **no** | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.spec.ts` |
| `b0b2dbecc5f9` | CleanUp3 | 01-api | `metadata()` | 3 | 7 | 14 | yes | — | `apps\api\src\meri\meri-research-child-task.pg.spec.ts` |
| `09bb1783f4ba` | CleanUp3 | 02-web | `mockapiroutes()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusPage.test.tsx` |
| `3355d402f79b` | CleanUp3 | 02-web | `numbered_future_district` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\directory\DistrictDetailView.test.tsx` |
| `76fa90e6dffd` | CleanUp3 | 02-web | `quarantine_response` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `b0b7018d8aaf` | 2 | 02-web | `queuebreadcrumb()` | 2 | 14 | 14 | **no** | — | `apps\web\src\pages\program-element\PersonCandidatesPage.tsx` |
| `fd105a5b78b3` | 1 | 02-web | `reconciliationentry` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\admin\PeReconciliationPage.tsx` |
| `d68ef9691f45` | 1 | 02-web | `region_bounds` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusMap.tsx` |
| `f584d35ce4b1` | CleanUp3 | 02-web | `renderconfig()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\clients\tracker\TrackerTab.conflict.test.tsx` |
| `39b2364ae835` | CleanUp3 | 02-web | `rendermodalnoantapp()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `09e73e171683` | 2 | 08-platform | `requiredany()` | 3 | 7 | 14 | **no** | — | `scripts\run-engagement-phase1-local.mjs` |
| `7d7a46fce600` | CleanUp3 | 02-web | `rulebody()` | 3 | 7 | 14 | yes | — | `apps\web\src\vnext\pages\district-nexus\district-nexus-layout.contract.test.ts` |
| `ba53049705b4` | 1 | 02-web | `sectionhead` | 3 | 7 | 14 | yes | — | `apps\web\src\pages\strategy\agents\ExecutionReview.tsx` |
| `879b48f233e8` | 2 | 02-web | `standardtooltip()` | 2 | 14 | 14 | **no** | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `a1fd36f19fab` | 1 | 01-api | `startoauthdto` | 2 | 14 | 14 | yes | — | `apps\api\src\engagement\google\google-oauth.controller.ts` |
| `f63afc31f32d` | 1 | 08-platform | `steps` | 2 | 14 | 14 | yes | — | `scripts\verify-outreach-v3-phase2-code.mjs` |
| `5eda9ac233d2` | 1 | 02-web | `supportswebgl()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusMap.tsx` |
| `925e1233503c` | 3 | 03-defense | `test_extractor_has_no_paid_or_external_runtime_imports()` | 2 | 14 | 14 | **no** | — | `apps\defense-budget-parser\tests\test_hasc_stage_extractor.py` |
| `3e98cc5a9938` | 1 | 02-web | `timelinerange()` | 2 | 14 | 14 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `9bee1bb5dd71` | 1 | 08-platform | `waitfordatabase()` | 2 | 14 | 14 | yes | — | `scripts\run-engagement-phase0-local.mjs` |
| `7f3cc21e7377` | 1 | 01-api | `withbypass()` | 3 | 7 | 14 | yes | — | `apps\api\scripts\backfill-funding-mapping-review.ts` |
| `ed0efe81c492` | 1 | 02-web | `.evaluate()` | 2 | 13 | 13 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `875e4df9a200` | 1 | 02-web | `.waitfor()` | 2 | 13 | 13 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `8fb211605bba` | 1 | 02-web | `bestdetailtab()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\engagement\meetings\MeetingsV2.tsx` |
| `7bead8c178b4` | 1 | 02-web | `comparisonrows()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `ea24eea9ba7c` | 1 | 02-web | `contactinfo` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\settings\ContactInfoPage.tsx` |
| `5c19192cbed0` | 1 | 02-web | `copycontact()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.tsx` |
| `7ea8991103e2` | CleanUp3 | 05-strategy | `env_keys` | 2 | 13 | 13 | **no** | — | `apps\api-strategy\src\agents\outbox-consumer.service.spec.ts` |
| `d98393e88ed0` | 1 | 08-platform | `expectsqlfailure()` | 2 | 13 | 13 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `0ba4d0e62a29` | 1 | 01-api | `extractopenaitext()` | 2 | 13 | 13 | yes | — | `apps\api\src\engagement\engagement-ai.service.ts` |
| `a842d48e0d21` | CleanUp3 | 02-web | `failendpoint()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\ProgramElementWatchPage.test.tsx` |
| `a6bed57bae99` | 1 | 01-api | `fetchjson()` | 2 | 13 | 13 | yes | — | `apps\api\scripts\sync-openlobby.ts` |
| `da4af4c711e9` | 1 | 02-web | `field_labels` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\strategy\RestoreImpactModal.tsx` |
| `8bea770788b9` | 1 | 02-web | `formatverified()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\PeTrustHeader.tsx` |
| `6d4aeac893cf` | CleanUp3 | 01-api | `fundingassertion()` | 2 | 13 | 13 | yes | **yes** | `apps\api\src\defense-budget\verification\rules\comparison\comparison-coverage.spec.ts` |
| `55d5fb9f764e` | 1 | 02-web | `governancetabs()` | 2 | 13 | 13 | yes | — | `apps\web\src\components\MemoryGovernanceCenter.tsx` |
| `a0676155db17` | 2 | 02-web | `heroscope()` | 2 | 13 | 13 | **no** | — | `apps\web\src\pages\bills\BillDossierHero.tsx` |
| `df436a998a98` | CleanUp3 | 02-web | `locationprobe()` | 2 | 13 | 13 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `8b8bd080afcd` | CleanUp3 | 01-api | `makecolumnbinding()` | 2 | 13 | 13 | yes | **yes** | `apps\api\src\defense-budget\om\om-composer-v1.spec.ts` |
| `d44dff3a9457` | 1 | 02-web | `parsedateonly()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `3b9100d48088` | 1 | 02-web | `relativetime()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\clients\TargetsTab.tsx` |
| `97685c63a333` | CleanUp3 | 02-web | `rendermodal()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `1e4b71e56106` | CleanUp3 | 02-web | `renderroute()` | 2 | 13 | 13 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `e60b2609b8fa` | 1 | 03-defense | `reporoot` | 2 | 13 | 13 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `314eb4856060` | 1 | 01-api | `reporootfromcwd()` | 2 | 13 | 13 | yes | — | `apps\api\scripts\verify-pe-phase-10.ts` |
| `71723864c504` | 1 | 08-platform | `run()` | 2 | 13 | 13 | yes | — | `scripts\verify-outreach-v3-phase2-code.mjs` |
| `478b50f36c50` | 1 | 02-web | `sourceinitials()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\HomePage.tsx` |
| `2e5aacc467e9` | 1 | 02-web | `timelineevent` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `1d36b95c289d` | 1 | 02-web | `tolinkedbills()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `a193ad5320fa` | 1 | 02-web | `tolinkedrules()` | 2 | 13 | 13 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `ef60927f5370` | 1 | 08-platform | `unwrapexpression()` | 2 | 13 | 13 | yes | — | `scripts\ci\verify-meri-visual-isolation.mjs` |
| `8c9af66c3741` | CleanUp3 | 01-api | `withenv()` | 2 | 13 | 13 | yes | — | `apps\api\src\memory\memory-store.governance.spec.ts` |
| `0edba179ef15` | 1 | 01-api | `.execute()` | 2 | 12 | 12 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-context.service.ts` |
| `8b9c6fa95893` | CleanUp3 | 01-api | `.findterminalrunbyidentity()` | 3 | 6 | 12 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `3d5be8edf650` | CleanUp3 | 01-api | `.loadcandidaterefs()` | 2 | 12 | 12 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `0c80e7e2914d` | 1 | 01-api | `.onmoduledestroy()` | 5 | 3 | 12 | yes | — | `apps\api\src\clients\client-profile-fill-workflow.service.ts` |
| `141e69245e57` | 1 | 05-strategy | `.onmoduledestroy()` | 3 | 6 | 12 | yes | — | `apps\api-strategy\src\agents\outbox-consumer.service.ts` |
| `5b7c26ec48d5` | 2 | 05-strategy | `.tick()` | 2 | 12 | 12 | **no** | — | `apps\api-strategy\src\agents\run-reconciler.service.ts` |
| `277f286aa143` | 2 | 01-api | `.tryresolvecredential()` | 2 | 12 | 12 | **no** | — | `apps\api\src\knowledge\entities\canonical-model-candidate-reconciliation.provider.ts` |
| `bbfa56af87de` | 3 | 03-defense | `_cells_for_row()` | 4 | 4 | 12 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `4d6d410882e3` | CleanUp3 | 01-api | `anthropictextresponse()` | 3 | 6 | 12 | **no** | — | `apps\api\src\intelligence\alert-memo\alert-memo-held-gate.spec.ts` |
| `f36b833d0a04` | CleanUp3 | 02-web | `api` | 13 | 1 | 12 | yes | — | `apps\web\src\vnext\pages\client-crm\ClientBudgetWatches.test.tsx` |
| `538f91b2f76e` | CleanUp3 | 02-web | `apideletemock` | 4 | 4 | 12 | **no** | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.test.tsx` |
| `a659a60dc16b` | CleanUp3 | 01-api | `apiroot()` | 3 | 6 | 12 | yes | — | `apps\api\src\engagement-workers\outreach-v3-full-generation-worker.spec.ts` |
| `f6273a4d5356` | 1 | 04-meri | `argument()` | 4 | 4 | 12 | yes | — | `packages\meriv2-core\scripts\jev-bd-gate-eval.ts` |
| `3988bec1ea49` | 2 | 08-platform | `assert()` | 3 | 6 | 12 | **no** | — | `scripts\verify-outreach-v3-phase4-code.mjs` |
| `a9e7eaa2311a` | 1 | 02-web | `band_color` | 3 | 6 | 12 | yes | — | `apps\web\src\pages\program-element\ProgramMatchQueuePage.tsx` |
| `888f7876caa7` | 1 | 04-meri | `bounded()` | 3 | 6 | 12 | yes | — | `packages\meriv2-core\src\assurance\claim-ledger.ts` |
| `afa17acce6df` | 1 | 06-intel | `boundederror()` | 3 | 6 | 12 | yes | — | `apps\intel-api\src\hearing\capture\automatic-stream-resolver.ts` |
| `e9b06dc54e4f` | 1 | 06-intel | `boundedpositiveinteger()` | 3 | 6 | 12 | yes | — | `apps\intel-api\src\hearing\capture\public-capture-persistent-queue.adapter.ts` |
| `5cac48ce77c4` | 1 | 01-api | `builddatabaseurlfromparts()` | 2 | 12 | 12 | yes | — | `apps\api\scripts\audit-llamaparse-pe-units.ts` |
| `d0b9a5bada20` | 1 | 01-api | `canonicalize()` | 2 | 12 | 12 | yes | — | `apps\api\src\research-portfolios\research-portfolio-review.service.ts` |
| `cf29a0baaec8` | CleanUp3 | 01-api | `context()` | 2 | 12 | 12 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-verification-wiring.spec.ts` |
| `faf61999c3f8` | 1 | 02-web | `contractorresult` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `9d21c3011f9c` | 1 | 08-platform | `counts` | 2 | 12 | 12 | yes | — | `scripts\run-engagement-phase1-post-acceptance.mjs` |
| `72ca53c29751` | 1 | 01-api | `createpaidclient()` | 2 | 12 | 12 | yes | — | `apps\api\scripts\build-rdte-cycle.ts` |
| `47eba4c08f27` | CleanUp3 | 05-strategy | `cur_fy` | 4 | 4 | 12 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `8da3cd62ff30` | 1 | 01-api | `delay_ms` | 3 | 6 | 12 | yes | — | `apps\api\scripts\enrich-award-districts.ts` |
| `9bd2a2c111ac` | 3 | 01-api | `dollars()` | 3 | 6 | 12 | yes | — | `apps\api\scripts\__tools__\build_dw_pseries.py` |
| `82da83eb3d75` | CleanUp3 | 02-web | `duplicate_aliases` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `07a1e7222692` | CleanUp3 | 04-meri | `envelope` | 2 | 12 | 12 | **no** | — | `packages\meriv2-core\src\jev\calibrated-cascade.spec.ts` |
| `0f861302bfaa` | 1 | 02-web | `evidencehref()` | 4 | 4 | 12 | yes | — | `apps\web\src\pages\program-element\ProgramMatchQueuePage.tsx` |
| `2907cdd363d8` | CleanUp3 | 01-api | `federal_alert` | 2 | 12 | 12 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.spec.ts` |
| `a7eb6ced1b18` | 1 | 01-api | `flag()` | 5 | 3 | 12 | yes | — | `apps\api\scripts\backfill-funding-mapping-review.ts` |
| `f82d4473205f` | CleanUp3 | 01-api | `fundingassertions()` | 3 | 6 | 12 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `7dd86a784805` | 1 | 01-api | `hasflag()` | 5 | 3 | 12 | yes | **yes** | `apps\api\scripts\file-defense-budget-promotion-plan-v1.ts` |
| `cbbe548e3c29` | 1 | 01-api | `hasmanualassociationoverride()` | 2 | 12 | 12 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `9699de287f8d` | CleanUp3 | 02-web | `idle` | 13 | 1 | 12 | yes | — | `apps\web\src\pages\strategy\HistoryModal.restore-impact.test.tsx` |
| `b9107f460d11` | 1 | 01-api | `isrecord()` | 5 | 3 | 12 | yes | — | `apps\api\src\directory\directory-photo.ts` |
| `b0665c1fb247` | 1 | 07-workspace-onboard | `itinviteview` | 2 | 12 | 12 | yes | — | `apps\onboard-api\src\it-admin\it-admin.service.ts` |
| `277c696546a8` | CleanUp3 | 01-api | `jsonresponse()` | 3 | 6 | 12 | yes | — | `apps\api\src\directory\legistorm\legistorm-client.spec.ts` |
| `7267fe044847` | 1 | 08-platform | `keyarn()` | 3 | 6 | 12 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `4be88247647f` | CleanUp3 | 02-web | `maketag()` | 2 | 12 | 12 | **no** | — | `apps\web\src\pages\clients\tracker\TrackerConfigPanel.savestate.test.tsx` |
| `1fe891e5cd8d` | 1 | 02-web | `membername()` | 4 | 4 | 12 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `2a4610cf2862` | 1 | 02-web | `newsdashboarditem` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\HomePage.tsx` |
| `9a670fff72a1` | 1 | 01-api | `nonblank` | 4 | 4 | 12 | yes | **yes** | `apps\api\src\defense-budget\promotion\manual-override-v1.ts` |
| `561f867c9332` | CleanUp3 | 01-api | `opportunity()` | 2 | 12 | 12 | yes | — | `apps\api\src\district-nexus\grant-opportunity-candidates.spec.ts` |
| `3ab972e69f86` | 1 | 08-platform | `output()` | 2 | 12 | 12 | yes | — | `scripts\verify-outreach-v3-phase5-code.mjs` |
| `1872bf161c26` | 1 | 01-api | `pagedresult` | 3 | 6 | 12 | yes | — | `apps\api\src\federal-register\federal-register.service.ts` |
| `c5cd5ab52ad4` | 1 | 02-web | `provider` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `39c7d7373070` | 1 | 08-platform | `quoteforshell()` | 4 | 4 | 12 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `fd72def8ab89` | 1 | 02-web | `readfirst()` | 3 | 6 | 12 | yes | — | `apps\web\src\pages\clients\ClientProfilePage.tsx` |
| `98c6c5e162dd` | 1 | 02-web | `readlist()` | 4 | 4 | 12 | yes | — | `apps\web\src\vnext\pages\directory\useCommitteeStaffModel.ts` |
| `eaa4b8788234` | 1 | 08-platform | `record()` | 4 | 4 | 12 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `b69dd77cbca4` | 1 | 08-platform | `reporoot` | 4 | 4 | 12 | yes | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `d99e73fcc87c` | CleanUp3 | 01-api | `repositorypath()` | 3 | 6 | 12 | yes | — | `apps\api\src\knowledge\graph\temporal-knowledge-graph-merge-continuity.contract.spec.ts` |
| `96097635ca61` | 1 | 01-api | `required()` | 3 | 6 | 12 | yes | — | `apps\api\src\context\internal-strategy-context.controller.ts` |
| `72193e17051e` | 1 | 08-platform | `root` | 2 | 12 | 12 | yes | — | `scripts\verify-phase8-session11.mjs` |
| `573af29d8806` | 1 | 02-web | `rowdelta()` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `b0b654d930ec` | 1 | 01-api | `rule()` | 3 | 6 | 12 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo-docx.ts` |
| `270fb89d0f87` | CleanUp3 | 01-api | `run()` | 2 | 12 | 12 | yes | — | `apps\api\src\meri\meri-research-child-task.pg.spec.ts` |
| `d5a959f91fe0` | CleanUp3 | 02-web | `setupapi()` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.test.tsx` |
| `22f2dd978080` | 1 | 05-strategy | `sortvalue()` | 2 | 12 | 12 | yes | — | `apps\api-strategy\src\agents\execution-assurance.spec.ts` |
| `0bfd66f3535d` | 1 | 02-web | `sourcehost()` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\program-element\ProgramTeamPanel.tsx` |
| `124e9a531424` | 1 | 05-strategy | `stablejson()` | 2 | 12 | 12 | yes | — | `apps\api-strategy\src\agents\watch-review.service.ts` |
| `76018a70c165` | 2 | 02-web | `state_tone` | 3 | 6 | 12 | **no** | — | `apps\web\src\pages\strategy\context\ContextLibrary.tsx` |
| `18c2d5fdcb89` | 1 | 02-web | `teamrow` | 2 | 12 | 12 | yes | — | `apps\web\src\pages\admin\TeamPage.tsx` |
| `3c0022e1ffe5` | 1 | 01-api | `tenantrow` | 4 | 4 | 12 | yes | — | `apps\api\scripts\backfill-client-kb.ts` |
| `b886b4ccaefb` | 1 | 01-api | `value()` | 3 | 6 | 12 | yes | — | `apps\api\scripts\backfill-funding-mapping-review.ts` |
| `2e6a5a17827b` | 1 | 03-defense | `value()` | 3 | 6 | 12 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `acbc6912b9cf` | 1 | 01-api | `withbypass()` | 3 | 6 | 12 | yes | — | `apps\api\scripts\diag-client-resolution.ts` |
| `9d5594de3ad5` | 1 | 02-web | `.evaluate()` | 2 | 11 | 11 | yes | — | `apps\web\scripts\engagement-phase3-browser-interactions.mjs` |
| `68d9afd62532` | CleanUp3 | 01-api | `.findcertificationbycontentsha256()` | 2 | 11 | 11 | yes | **yes** | `apps\api\src\defense-budget\phase6\phase6-audit-projection-repository.spec.ts` |
| `17356eabd16d` | CleanUp3 | 02-web | `apiputmock` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\clients\tracker\TrackerTab.conflict.test.tsx` |
| `95f74e7fbbb5` | CleanUp3 | 02-web | `chooseandmap()` | 2 | 11 | 11 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioGovernedInteractions.test.tsx` |
| `d0eeeaae3de4` | CleanUp3 | 01-api | `context()` | 2 | 11 | 11 | yes | — | `apps\api\src\capabilities\capability-authorization.service.spec.ts` |
| `0047827df4db` | 1 | 02-web | `cookiesfromheader()` | 2 | 11 | 11 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `010819ffb78c` | CleanUp3 | 01-api | `ctx` | 2 | 11 | 11 | yes | — | `apps\api\src\capabilities\targets\search-targets.capability.spec.ts` |
| `37f1b57dc4c4` | CleanUp3 | 01-api | `ctx()` | 2 | 11 | 11 | yes | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.spec.ts` |
| `f43fb3d69f38` | 1 | 02-web | `detailtolistitem()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\program-element\v2\PeV2LegislativeTab.tsx` |
| `c1fe7d8c621d` | 1 | 02-web | `dossierheroprops` | 2 | 11 | 11 | yes | — | `apps\web\src\components\dossier\DossierHero.tsx` |
| `a11dd9fe8492` | 1 | 02-web | `downloadcsv()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `13284589c915` | 1 | 02-web | `extension_content_type` | 2 | 11 | 11 | yes | — | `apps\web\src\lib\attachment-content-type.ts` |
| `f978c9d8f8a0` | 1 | 08-platform | `failures` | 2 | 11 | 11 | yes | — | `scripts\verify-phase8-session11.mjs` |
| `8fe56be23aec` | 1 | 02-web | `firmskillrow` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `54dfd7797cf1` | 1 | 01-api | `firstevidencepage()` | 2 | 11 | 11 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `cfd505bb89e9` | 1 | 01-api | `jsontext()` | 2 | 11 | 11 | yes | — | `apps\api\src\capabilities\context\outreach-context-reference.service.ts` |
| `d028e07aa50e` | 1 | 08-platform | `mainenv` | 2 | 11 | 11 | yes | — | `scripts\run-engagement-phase1-post-acceptance.mjs` |
| `b246bb04b4cd` | CleanUp3 | 01-api | `makenumberedpage()` | 2 | 11 | 11 | yes | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.spec.ts` |
| `41f85e0c725d` | CleanUp3 | 01-api | `maketable()` | 2 | 11 | 11 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\o1\o1-extractor-v1.spec.ts` |
| `0dc169d0435b` | 1 | 02-web | `mergepersondetail` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\capiro-admin\CapiroAdminPage.tsx` |
| `c9d63de46e86` | 1 | 02-web | `normalize()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\clients\CapabilityDrawer.tsx` |
| `69d506e61d1d` | 1 | 01-api | `parseargs()` | 2 | 11 | 11 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `7da384c0d9c8` | 2 | 01-api | `parsejsonobject()` | 2 | 11 | 11 | **no** | — | `apps\api\src\engagement\engagement-ai.service.ts` |
| `185bd4b9438a` | CleanUp3 | 01-api | `prismafor()` | 2 | 11 | 11 | yes | — | `apps\api\src\capabilities\capability-authorization.service.spec.ts` |
| `9f676835028a` | CleanUp3 | 01-api | `researchportfoliometadata()` | 2 | 11 | 11 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `3edfbcaebd29` | 1 | 08-platform | `root` | 2 | 11 | 11 | yes | — | `scripts\verify-phase8-session2.mjs` |
| `39e25574c121` | 1 | 01-api | `runpnpm()` | 2 | 11 | 11 | yes | — | `apps\api\scripts\verify-memory-phase2-notification-closeout.ts` |
| `c876bd5c9b8f` | 1 | 01-api | `safecount()` | 2 | 11 | 11 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.ts` |
| `174966f8b1f1` | 1 | 01-api | `safevalue()` | 2 | 11 | 11 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.ts` |
| `b0cf7a0a8f20` | 1 | 02-web | `sectiontext()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\engagement\EngagementPage.tsx` |
| `8afe0e54594b` | CleanUp3 | 06-intel | `segment` | 2 | 11 | 11 | yes | — | `apps\intel-api\src\hearing\intelligence\public-hearing-intelligence.coordinator.spec.ts` |
| `c8df7e93fb3b` | CleanUp3 | 01-api | `statusmatches()` | 2 | 11 | 11 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `1ef2ff3a16a9` | 1 | 01-api | `syncstats` | 2 | 11 | 11 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `040aec63cb70` | 1 | 02-web | `usemissions()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `15e023591e8c` | 1 | 02-web | `usepfnarrow()` | 2 | 11 | 11 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\FilesTab.tsx` |
| `6925aed670dd` | 1 | 02-web | `useputfirmphases()` | 2 | 11 | 11 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `3ced7c42e124` | 1 | 01-api | `verifygrounded()` | 2 | 11 | 11 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `a4104f8fbea7` | CleanUp3 | 01-api | `.$queryrawunsafe()` | 2 | 10 | 10 | **no** | — | `apps\api\scripts\diag-funding-opportunities-makegov.spec.ts` |
| `65534530cf97` | 1 | 07-workspace-onboard | `.assertdraft()` | 3 | 5 | 10 | yes | — | `apps\workspace\src\collaborators\collaborators.service.ts` |
| `a05d92a95b2d` | 1 | 01-api | `.clientname()` | 2 | 10 | 10 | yes | — | `apps\api\src\engagement\generation\outreach-context-plane.service.ts` |
| `2f5cc091b983` | 1 | 04-meri | `.scoped()` | 2 | 10 | 10 | yes | — | `apps\meriv2-orchestrator\src\meri\steward\steward.controller.ts` |
| `0f455e3990c7` | 1 | 02-web | `.screenshot()` | 2 | 10 | 10 | yes | — | `apps\web\scripts\engagement-phase3-browser-interactions.mjs` |
| `548d3a495dd3` | 3 | 03-defense | `_build_result()` | 2 | 10 | 10 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\camelot_engine.py` |
| `c837958d8268` | 1 | 02-web | `action_type_color` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `090ca82e51ec` | 1 | 02-web | `action_type_label` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `90811187030e` | 1 | 01-api | `adddays()` | 3 | 5 | 10 | yes | — | `apps\api\src\engagement\engagement.service.ts` |
| `2ff62dddfe2a` | CleanUp3 | 01-api | `apiroot` | 3 | 5 | 10 | yes | — | `apps\api\scripts\lib\memory-phase2-persistence-contract.spec.ts` |
| `2f2d4932f444` | 1 | 02-web | `assistancerecipientresult` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `9aae341fdd50` | 2 | 01-api | `aws()` | 2 | 10 | 10 | **no** | — | `apps\api\scripts\verify-image-parity.ts` |
| `bdead66d22b7` | 1 | 05-strategy | `bearerfrom()` | 3 | 5 | 10 | yes | — | `apps\api-strategy\src\agents\agents.controller.ts` |
| `0acc0c3ba106` | 1 | 02-web | `bill_type_labels` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `c8937a81c41f` | CleanUp3 | 01-api | `canonicalorg` | 2 | 10 | 10 | yes | — | `apps\api\src\business-development\bizdev-dossier.service.spec.ts` |
| `ba7a32128d69` | CleanUp3 | 01-api | `committed` | 2 | 10 | 10 | yes | — | `apps\api\scripts\lib\memory-phase2-persistence-contract.spec.ts` |
| `24f6d9e4ef37` | 1 | 02-web | `component_colors` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `f0fd7ab7e96b` | CleanUp3 | 06-intel | `context` | 3 | 5 | 10 | yes | — | `apps\intel-api\src\hearing\intelligence\deterministic-public-hearing-extractor.spec.ts` |
| `b1f67f34410e` | 1 | 02-web | `dashoutreach` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\HomePage.tsx` |
| `2cb0fad1c234` | 1 | 02-web | `display_stage` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `1321829db338` | 1 | 03-defense | `dist()` | 2 | 10 | 10 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `7fe6496c6e5c` | CleanUp3 | 02-web | `emptycontext()` | 2 | 10 | 10 | yes | — | `apps\web\src\vnext\pages\engagement\outreach-step-context.test.tsx` |
| `af9b17c21857` | 1 | 02-web | `evidencetarget()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `9050f5434439` | 1 | 01-api | `extractanthropictext()` | 2 | 10 | 10 | yes | — | `apps\api\src\engagement\engagement-ai.service.ts` |
| `98836c5a2bd4` | 1 | 08-platform | `failures` | 2 | 10 | 10 | yes | — | `scripts\verify-phase8-session2.mjs` |
| `79e9832d49ad` | CleanUp3 | 01-api | `federaltools()` | 2 | 10 | 10 | yes | — | `apps\api\src\meri\governed-meri-tools.chart-scope.spec.ts` |
| `6cc607bcb953` | 2 | 01-api | `fetchjson()` | 2 | 10 | 10 | **no** | — | `apps\api\scripts\sync-census.ts` |
| `14557919ecd0` | 1 | 08-platform | `file()` | 2 | 10 | 10 | yes | — | `scripts\verify-phase8-session11.mjs` |
| `cba24e6a849a` | 1 | 02-web | `fmtts()` | 3 | 5 | 10 | yes | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.tsx` |
| `4757827e6b7f` | 1 | 08-platform | `fullsnapshotrows()` | 2 | 10 | 10 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `e1ae573b6b97` | CleanUp3 | 01-api | `governed()` | 2 | 10 | 10 | yes | — | `apps\api\src\memory\immutable-memory-version.service.spec.ts` |
| `a217fca8615a` | CleanUp3 | 01-api | `identity` | 3 | 5 | 10 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\cycle-family-readiness-orchestrator-v1.spec.ts` |
| `93ee4db8be2c` | 1 | 02-web | `initials()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\clients\tracker\TrackerFeedPanel.tsx` |
| `01fe361d3a65` | CleanUp3 | 01-api | `input` | 3 | 5 | 10 | **no** | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-source-profile-v1.spec.ts` |
| `4f34a81e9802` | 1 | 02-web | `integrationconnection` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `80d3bb31c4a8` | 1 | 02-web | `invalidategovernance()` | 2 | 10 | 10 | yes | — | `apps\web\src\components\MemoryGovernanceCenter.tsx` |
| `f05a056f7ca2` | 1 | 08-platform | `isproductionsource()` | 2 | 10 | 10 | yes | — | `scripts\verify-outreach-v3-phase4-code.mjs` |
| `880f1b12439a` | CleanUp3 | 02-web | `job` | 2 | 10 | 10 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioGovernedInteractions.test.tsx` |
| `962a19e704ad` | CleanUp3 | 01-api | `jsonresponse()` | 2 | 10 | 10 | yes | — | `apps\api\src\engagement\google\google-sync.retry.spec.ts` |
| `9633f34ead35` | 1 | 02-web | `latestactionevent()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `7f82f87d2de3` | 1 | 02-web | `ldasearchresult` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `82e11d139b90` | CleanUp3 | 01-api | `lineage` | 2 | 10 | 10 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-service-v1.spec.ts` |
| `776bc2ab5383` | CleanUp3 | 01-api | `makerequesttable()` | 2 | 10 | 10 | yes | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.spec.ts` |
| `38ce8bb6db21` | CleanUp3 | 01-api | `maketable()` | 2 | 10 | 10 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.spec.ts` |
| `b6c8e7df1805` | 1 | 02-web | `mergecandidate` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\capiro-admin\CapiroAdminPage.tsx` |
| `53b3bcc91db2` | CleanUp3 | 02-web | `mocks` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `7ec51e51ea41` | 1 | 04-meri | `normalize()` | 3 | 5 | 10 | yes | — | `packages\meriv2-core\src\assurance\risk-gate.ts` |
| `b98a7589d103` | 1 | 08-platform | `operationscfg` | 3 | 5 | 10 | yes | — | `infra\cdk\bin\defense-budget-annual-operations.ts` |
| `c0cb16a23f23` | 1 | 04-meri | `orderedunique()` | 2 | 10 | 10 | yes | — | `packages\meriv2-core\src\assurance\claim-ledger.ts` |
| `f364c5fb7e73` | 1 | 08-platform | `partitionforregion()` | 3 | 5 | 10 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `4acd51076e71` | 1 | 01-api | `pngcrc32()` | 2 | 10 | 10 | yes | — | `apps\api\src\clients\clients.service.spec.ts` |
| `55be57ea43a9` | 1 | 05-strategy | `pngcrc32()` | 2 | 10 | 10 | yes | — | `apps\api-strategy\src\reports\report-image.spec.ts` |
| `e2eb36b11d1f` | CleanUp3 | 02-web | `preview` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `ab1d08883d57` | CleanUp3 | 01-api | `prismalocatorreader` | 2 | 10 | 10 | yes | **yes** | `apps\api\src\defense-budget\governed-acceptance\candidate-correction\phase10b35c-candidate-correction-e2e.integration.spec.ts` |
| `25dfb674ccb0` | 2 | 01-api | `provenance` | 2 | 10 | 10 | **no** | **yes** | `apps\api\scripts\phase6-producer-rehearsal.ts` |
| `8e525978ebd8` | CleanUp3 | 02-web | `provenance` | 2 | 10 | 10 | **no** | — | `apps\web\src\components\chat\AnalysisChartCard.test.tsx` |
| `75ec70a78148` | 1 | 01-api | `rawpage` | 3 | 5 | 10 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `d95f4d70911e` | 1 | 01-api | `readboundedinteger()` | 2 | 10 | 10 | yes | — | `apps\api\src\knowledge\episodes\knowledge-episode-worker-config.service.ts` |
| `6771aaf49806` | 1 | 01-api | `record()` | 3 | 5 | 10 | yes | — | `apps\api\src\external\tango\tango-subaward.mapper.ts` |
| `fb1c3f8f58d4` | 1 | 04-meri | `record()` | 3 | 5 | 10 | yes | — | `apps\meriv2-orchestrator\src\meri\jev\passage-selector.ts` |
| `1bcd3ce3c503` | 1 | 02-web | `relativetime()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\HomePage.tsx` |
| `af15016d4d2e` | 1 | 02-web | `relativetime()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\intelligence\ChangesInboxPage.tsx` |
| `aae0820a4e44` | CleanUp3 | 02-web | `renderlegislative()` | 2 | 10 | 10 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\IntelligenceTab.legislative-v2.test.tsx` |
| `669778be3dcc` | 1 | 08-platform | `required()` | 3 | 5 | 10 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `b129c50b6d93` | 1 | 01-api | `requiredenv()` | 3 | 5 | 10 | yes | — | `apps\api\scripts\drain-defense-budget-ingestion-outbox-v1.ts` |
| `5bd98417763a` | 1 | 08-platform | `resolvereporoot()` | 2 | 10 | 10 | yes | — | `scripts\verify-phase8-session6.mjs` |
| `66d04ae99069` | 1 | 01-api | `resolvetenantid()` | 2 | 10 | 10 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `4e58cab8c797` | CleanUp3 | 02-web | `routeget()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `bc07e2d41eea` | 1 | 02-web | `sanitizeurl()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `aec9c224c901` | 1 | 01-api | `secretmatches()` | 3 | 5 | 10 | yes | — | `apps\api\src\meri\meri-chat-attachment-transport.ts` |
| `6b1ecb576b4e` | 1 | 02-web | `sessionstore()` | 2 | 10 | 10 | yes | — | `apps\web\src\lib\engagement-api-preview.ts` |
| `a815de2e6a03` | 1 | 02-web | `skill_limits` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `fd2821638313` | CleanUp3 | 01-api | `sqltext()` | 3 | 5 | 10 | yes | — | `apps\api\src\memory\immutable-memory-version.service.spec.ts` |
| `dd6360ba0cf7` | 1 | 02-web | `stage_to_field` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\program-element\v2\PeV2SourceInspector.tsx` |
| `def4a2cbe890` | CleanUp3 | 08-platform | `synth()` | 2 | 10 | 10 | yes | — | `infra\cdk\test\engagement-api-least-privilege.spec.ts` |
| `2465ebce5e6f` | 1 | 02-web | `tenantrow` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\capiro-admin\CapiroAdminPage.tsx` |
| `23a8c5d7b1c5` | 3 | 03-defense | `test_json_output_uses_typescript_camel_case_contract()` | 2 | 10 | 10 | **no** | — | `apps\defense-budget-parser\tests\test_hasc_stage_extractor.py` |
| `20518fdf8006` | 1 | 04-meri | `tokens()` | 2 | 10 | 10 | yes | — | `packages\meriv2-core\src\learning\rollout.ts` |
| `c5c7ae7ccaf1` | CleanUp3 | 04-meri | `toolresp()` | 2 | 10 | 10 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy-assistant.service.spec.ts` |
| `03e500ca5011` | 1 | 04-meri | `toolschema` | 3 | 5 | 10 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-assistant.service.ts` |
| `82e99161aa14` | 1 | 02-web | `torecord()` | 3 | 5 | 10 | yes | — | `apps\web\src\pages\clients\ClientProfilePage.tsx` |
| `8e61fc7f8d7c` | 1 | 02-web | `type_colors` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `119928f9962b` | 1 | 02-web | `usecreatestrategy()` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `92a3cf876e57` | CleanUp3 | 01-api | `walktsfiles()` | 2 | 10 | 10 | yes | — | `apps\api\src\memory\memory-private-fail-closed.spec.ts` |
| `b582f6d2e6b1` | 1 | 03-defense | `withtempfile()` | 2 | 10 | 10 | yes | — | `apps\defense-parser-orchestrator\src\aws-real-storage.mjs` |
| `63905ef92b26` | 1 | 02-web | `workqueueitem` | 2 | 10 | 10 | yes | — | `apps\web\src\pages\HomePage.tsx` |
| `d4b06bef1c67` | 1 | 01-api | `.assertclient()` | 2 | 9 | 9 | yes | — | `apps\api\src\clients\client-capability-fit.service.ts` |
| `c0217762788a` | 1 | 01-api | `.capabilities()` | 4 | 3 | 9 | yes | — | `apps\api\src\engagement\google\google-integration-actions.controller.ts` |
| `6f7430daa194` | 1 | 01-api | `.configured()` | 4 | 3 | 9 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `7b32759927f0` | CleanUp3 | 01-api | `.insertcertificationprojectionbinding()` | 2 | 9 | 9 | yes | **yes** | `apps\api\src\defense-budget\phase6\phase6-audit-projection-repository.spec.ts` |
| `5148b38b0918` | 1 | 03-defense | `.listpersistentendpoints()` | 2 | 9 | 9 | yes | — | `apps\defense-parser-orchestrator\src\aws-real-storage.mjs` |
| `fc61bdc06ae4` | CleanUp3 | 01-api | `.record()` | 4 | 3 | 9 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-service-v1.spec.ts` |
| `53a8c66a66e0` | 1 | 02-web | `.send()` | 2 | 9 | 9 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `f91350b354a3` | 1 | 01-api | `anthropicresponse` | 4 | 3 | 9 | yes | — | `apps\api\scripts\eval-clio-analysis.ts` |
| `699eda461aba` | CleanUp3 | 01-api | `anthropictextresponse()` | 2 | 9 | 9 | **no** | — | `apps\api\src\intelligence\alert-memo\alert-memo-citations.spec.ts` |
| `46b8a95fd7dd` | CleanUp3 | 02-web | `apigetmock` | 2 | 9 | 9 | **no** | — | `apps\web\src\pages\intelligence\ChangesInboxPage.test.tsx` |
| `ebdd64e2c0c1` | 1 | 08-platform | `approot` | 4 | 3 | 9 | yes | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `87f8a2cf462a` | CleanUp3 | 01-api | `authoritativedecision()` | 2 | 9 | 9 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `f22f0491691b` | 1 | 02-web | `authtype` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `2dc939a8f8a6` | 1 | 08-platform | `banned_content_keys` | 2 | 9 | 9 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `f50d5dbf4193` | 1 | 01-api | `boundedtext()` | 2 | 9 | 9 | yes | — | `apps\api\src\outreach-v3\state\outreach-campaign-spec.v1.ts` |
| `c4ba12704887` | 1 | 01-api | `canonicaljson()` | 2 | 9 | 9 | yes | — | `apps\api\src\capabilities\context\outreach-context.contract.ts` |
| `46b83e82ae9e` | 1 | 01-api | `client()` | 4 | 3 | 9 | yes | — | `apps\api\scripts\verify-memory-admin-self-approval-database.ts` |
| `f389e7d66064` | 1 | 02-web | `closed_action_statuses` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `44cc96900e94` | CleanUp3 | 01-api | `configmock()` | 4 | 3 | 9 | yes | — | `apps\api\src\defense-budget-lifecycle\defense-budget-lifecycle-internal.guard.spec.ts` |
| `696ca4e55495` | CleanUp3 | 02-web | `credentials` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\settings\AiUsagePage.test.tsx` |
| `d5092cc868c8` | CleanUp3 | 05-strategy | `ctxwith()` | 2 | 9 | 9 | yes | — | `apps\api-strategy\src\flags\agentic.guard.spec.ts` |
| `7d11ccdc5f73` | CleanUp3 | 01-api | `currentturn()` | 2 | 9 | 9 | yes | — | `apps\api\src\meri\meri-chat-attachment-transport.http.spec.ts` |
| `5d6c36afe7b5` | 1 | 01-api | `databasehost()` | 2 | 9 | 9 | yes | — | `apps\api\scripts\execute-defense-budget-promotion-v1.ts` |
| `48dc617ee903` | 1 | 01-api | `decimalequal()` | 2 | 9 | 9 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `4bd0f8493b3a` | CleanUp3 | 02-web | `deferred()` | 2 | 9 | 9 | yes | — | `apps\web\src\vnext\meri\VNextMeriComposer.drafts-import.test.tsx` |
| `6ad943a3fba2` | 1 | 02-web | `directorycontactsresponse` | 2 | 9 | 9 | yes | — | `apps\web\src\components\QuickLog.tsx` |
| `fb2789396c82` | 1 | 01-api | `errormessages()` | 2 | 9 | 9 | yes | — | `apps\api\scripts\validate-defense-budget-cycle-manifest.ts` |
| `98a08d79062c` | 1 | 02-web | `eventsforbill()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `de0e47f31d32` | 1 | 08-platform | `exists()` | 2 | 9 | 9 | yes | — | `scripts\verify-phase8-session11.mjs` |
| `5ee994a6a231` | 1 | 01-api | `expectrefused()` | 2 | 9 | 9 | yes | — | `apps\api\scripts\pe-budget-phase7-drain-rehearsal.ts` |
| `8be128884433` | 1 | 08-platform | `file()` | 2 | 9 | 9 | yes | — | `scripts\verify-phase8-session2.mjs` |
| `c45b356a4226` | 1 | 02-web | `formatdatetime()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `d11d6e19fbb5` | 1 | 02-web | `formattranscripttime()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsPhase7Surface.tsx` |
| `da44ff3b867b` | CleanUp3 | 02-web | `get` | 4 | 3 | 9 | **no** | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `94ee4f2326a6` | 1 | 02-web | `helpitem` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\help\HelpPage.tsx` |
| `10e75fb21c98` | 1 | 02-web | `initialsof()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\workspace\ContextBuilderPage.tsx` |
| `73636fc9ceae` | 1 | 01-api | `ismissingstatus()` | 4 | 3 | 9 | yes | — | `apps\api\src\clients\client-profile-fill-context-plane.service.ts` |
| `baed1f30be4b` | 1 | 03-defense | `loaddomain()` | 2 | 9 | 9 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `4c3789858eb7` | CleanUp3 | 02-web | `locationprobe()` | 2 | 9 | 9 | yes | — | `apps\web\src\vnext\pages\legiwatch\committees\CommitteesTab.test.tsx` |
| `93bbd4e0ee95` | CleanUp3 | 02-web | `locationspy()` | 2 | 9 | 9 | yes | — | `apps\web\src\vnext\pages\engagement\VNextMeetingLibrary.test.tsx` |
| `0bc3ef56f7c8` | 1 | 01-api | `metaline()` | 2 | 9 | 9 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo-docx.ts` |
| `85bd1a12f95d` | 1 | 02-web | `models_by_provider` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.tsx` |
| `cad105429e61` | 1 | 01-api | `nonnegativeinteger()` | 4 | 3 | 9 | yes | — | `apps\api\src\meri\meri-research-child-task.ts` |
| `f6d6bc143b33` | 1 | 08-platform | `output()` | 2 | 9 | 9 | yes | — | `scripts\verify-outreach-v3-phase4-6-combined.mjs` |
| `1dcd413cd18f` | 2 | 01-api | `parseaeskey()` | 2 | 9 | 9 | **no** | — | `apps\api\src\engagement\meeting-notes-crypto.service.ts` |
| `c195d1fc0950` | 1 | 02-web | `props` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusTable.tsx` |
| `d31143ccb3a7` | 1 | 07-workspace-onboard | `read()` | 2 | 9 | 9 | yes | — | `apps\onboard-api\src\auth\org-tenant-resolver.provider.ts` |
| `79a4277f665d` | CleanUp3 | 01-api | `readjson()` | 4 | 3 | 9 | yes | — | `apps\api\src\program-element\parsers\armed-services-report-parser.spec.ts` |
| `95eefc9b7a25` | 2 | 02-web | `relativetime()` | 2 | 9 | 9 | **no** | — | `apps\web\src\components\WorkspaceNotificationBell.tsx` |
| `c98ca3a6a888` | CleanUp3 | 02-web | `renderreview()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\agents\ExecutionReview.approval.test.tsx` |
| `de90b1cbeffb` | CleanUp3 | 02-web | `review_counts` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `3121cae0e86f` | 2 | 01-api | `rowfingerprint()` | 2 | 9 | 9 | **no** | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `47f82528da07` | 1 | 01-api | `sha256()` | 4 | 3 | 9 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-lifecycle.ts` |
| `5d353309b3db` | 1 | 01-api | `sha256()` | 2 | 9 | 9 | yes | — | `apps\api\src\meri\meri-action-item-read.helpers.ts` |
| `c2db8e3f8330` | 1 | 01-api | `sha256()` | 2 | 9 | 9 | yes | — | `apps\api\src\meri\meri-debrief-read.helpers.ts` |
| `9728ed454559` | 1 | 04-meri | `sha256()` | 4 | 3 | 9 | yes | — | `packages\meriv2-core\src\assurance\claim-ledger.ts` |
| `cae60a8d46ce` | 1 | 01-api | `sortjson()` | 2 | 9 | 9 | yes | — | `apps\api\src\knowledge\entities\entity-identity-governance.service.ts` |
| `4b6941bbd52e` | 1 | 04-meri | `sourcehasevidence()` | 4 | 3 | 9 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-retrieval-bill-watch.ts` |
| `10fae99b9c2b` | CleanUp3 | 01-api | `table()` | 4 | 3 | 9 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `ea5830add8da` | 1 | 02-web | `tobase64utf8()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\settings\PersonalPage.tsx` |
| `8778e385ef6f` | 1 | 02-web | `usefirmphases()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `863c6c3400df` | 1 | 02-web | `usereferencecalendars()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `9c2ec2a00ae6` | 1 | 02-web | `userejectchangeset()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `20a3743899bf` | 1 | 02-web | `userejectcontextfact()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `43d98cd07d38` | 1 | 02-web | `usestrategies()` | 2 | 9 | 9 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `468c54e92a47` | CleanUp3 | 08-platform | `validenv` | 2 | 9 | 9 | yes | — | `scripts\verify-outreach-v3-phase2-db.test.mjs` |
| `c32a144bfa39` | 1 | 01-api | `valuesequal()` | 2 | 9 | 9 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `0dd2f7da18cc` | CleanUp3 | 02-web | `wrapper()` | 4 | 3 | 9 | yes | — | `apps\web\src\components\chat\useMeriChatController.approval-recovery.test.tsx` |
| `4b98c8142f6d` | 2 | 03-defense | `.#exec()` | 2 | 8 | 8 | **no** | — | `apps\defense-parser-orchestrator\src\aws-real-storage.mjs` |
| `de20c72b65f2` | 1 | 01-api | `.canactivate()` | 2 | 8 | 8 | yes | — | `apps\api\src\outreach-v3\api\outreach-v3-state.guard.ts` |
| `50b1302bd35b` | 1 | 01-api | `.canactivate()` | 3 | 4 | 8 | yes | — | `apps\api\src\business-development\bizdev-brief.flag.guard.ts` |
| `862858fc9d50` | 1 | 02-web | `.navigate()` | 2 | 8 | 8 | yes | — | `apps\web\scripts\engagement-phase1-browser-parity.mjs` |
| `96352fe69408` | 1 | 05-strategy | `.render()` | 3 | 4 | 8 | yes | — | `apps\api-strategy\src\reports\docx-report.renderer.ts` |
| `673e4c32e429` | 1 | 01-api | `.upsertperson()` | 2 | 8 | 8 | yes | — | `apps\api\src\acquisition-personnel\importers\dow-directory-v6-importer.ts` |
| `a501eb98d7be` | 1 | 02-web | `action_tone` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\BudgetLinePanels.tsx` |
| `61fcbf96fc54` | 1 | 02-web | `admintenantusagerow` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.tsx` |
| `343404a48ad2` | CleanUp3 | 02-web | `apipatchmock` | 2 | 8 | 8 | **no** | — | `apps\web\src\pages\intelligence\ChangesInboxPage.test.tsx` |
| `e2e3681fcace` | 1 | 01-api | `arg()` | 3 | 4 | 8 | yes | — | `apps\api\scripts\drain-federal-evidence-outbox.ts` |
| `8936acf05bc8` | 1 | 01-api | `artifact` | 2 | 8 | 8 | yes | — | `apps\api\scripts\parse-defense-approps-reports.ts` |
| `1a7fd199b39c` | 1 | 01-api | `ascount()` | 3 | 4 | 8 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `53287893e69a` | 1 | 02-web | `awarddateheader()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `624e6cb1a417` | 1 | 01-api | `bounded()` | 2 | 8 | 8 | yes | — | `apps\api\src\capabilities\context\outreach-context.contract.ts` |
| `c0c2ce5cae07` | 1 | 01-api | `boundedinteger()` | 3 | 4 | 8 | yes | — | `apps\api\src\live-hearings\phase9\legiwatch-phase9-central-discovery.service.ts` |
| `db7607de25f2` | CleanUp3 | 01-api | `captured` | 3 | 4 | 8 | yes | — | `apps\api\src\memory\exact-memory-cleanup-outbox.service.spec.ts` |
| `a349e5d3da3d` | 1 | 02-web | `clientoption` | 3 | 4 | 8 | yes | — | `apps\web\src\components\chat\useMeriChatController.ts` |
| `50311478fa02` | 1 | 02-web | `clustertooltip()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `5b737bb8bfa7` | CleanUp3 | 04-meri | `config` | 2 | 8 | 8 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.spec.ts` |
| `0d45e941c4f3` | 1 | 04-meri | `contentblock` | 2 | 8 | 8 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.ts` |
| `9a7588744a0c` | CleanUp3 | 01-api | `ctx` | 9 | 1 | 8 | **no** | — | `apps\api\src\intelligence\alert-memo\governed-alert-deliverables.phase22.spec.ts` |
| `5e6efb42f527` | CleanUp3 | 01-api | `ctx` | 2 | 8 | 8 | **no** | — | `apps\api\src\engagement\notetaker\notetaker.service.spec.ts` |
| `f996bc6635cd` | 1 | 01-api | `databaserole()` | 2 | 8 | 8 | yes | — | `apps\api\scripts\execute-defense-budget-promotion-v1.ts` |
| `d5f053e7269f` | CleanUp3 | 01-api | `datematches()` | 2 | 8 | 8 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `269f7d1b5c9c` | CleanUp3 | 05-strategy | `decodexml()` | 2 | 8 | 8 | yes | — | `apps\api-strategy\src\reports\report-amendment.spec.ts` |
| `99fa1ddc5ea9` | 1 | 06-intel | `deepgramtranscript` | 2 | 8 | 8 | yes | — | `apps\intel-api\src\hearing\capture\server-deepgram-stream.manager.ts` |
| `fb56fcb8953a` | CleanUp3 | 02-web | `deletemock` | 3 | 4 | 8 | **no** | — | `apps\web\src\vnext\pages\client-crm\ManageFacilitiesModal.test.tsx` |
| `849279349e81` | CleanUp3 | 04-meri | `directories` | 3 | 4 | 8 | yes | — | `packages\meriv2-core\src\canary\canary-report-cli.spec.ts` |
| `ee146bda96d3` | 1 | 02-web | `dossierheroscope` | 2 | 8 | 8 | yes | — | `apps\web\src\components\dossier\DossierHero.tsx` |
| `422df1804276` | 2 | 02-web | `drillkv()` | 2 | 8 | 8 | **no** | — | `apps\web\src\pages\explorer\bill-detail.tsx` |
| `0f9e545c9759` | 2 | 02-web | `drillsection()` | 2 | 8 | 8 | **no** | — | `apps\web\src\pages\explorer\bill-detail.tsx` |
| `7ad8623153b5` | 1 | 02-web | `eventkind` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `a8b0dab3957b` | 1 | 02-web | `evmeta()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\bills\BillOverviewTab.tsx` |
| `bdb2828591f1` | 1 | 08-platform | `exact_shadow_env` | 2 | 8 | 8 | yes | — | `scripts\lib\verify-engagement-api-task-config-legacy.mjs` |
| `15843dd9c4a3` | 1 | 02-web | `exhibit_color` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\ProofPackPanel.tsx` |
| `78d19c87b4dd` | 1 | 08-platform | `fail()` | 3 | 4 | 8 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `712bb70e483c` | 1 | 02-web | `fecemployerresult` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `9515379f5d01` | 1 | 02-web | `federalmembersummary` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\intelligence-v1\representation-api.ts` |
| `e8d190c37b95` | 2 | 08-platform | `firsttenantid()` | 2 | 8 | 8 | **no** | — | `scripts\verify-phase8-session11-integration.mjs` |
| `f303324ef0b4` | 1 | 02-web | `fmtdollars()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\SecondaryDistributionPanel.tsx` |
| `bfe5d404862c` | CleanUp3 | 02-web | `get` | 5 | 2 | 8 | yes | — | `apps\web\src\vnext\pages\directory\CongressionalStaffVNext.test.tsx` |
| `9d95e61f12f3` | 1 | 02-web | `importcandidate` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\FirmOnboardingWizard.tsx` |
| `70507fd7139b` | 1 | 02-web | `initials()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\ClientProfilePage.tsx` |
| `93a95f5d531c` | CleanUp3 | 01-api | `insert()` | 2 | 8 | 8 | **no** | — | `apps\api\src\meri\meri-research-child-task.pg.spec.ts` |
| `dd58ef6a8d3b` | 1 | 01-api | `integerenv()` | 3 | 4 | 8 | yes | — | `apps\api\scripts\sync-district-economic-acs.ts` |
| `c56595a08760` | 1 | 08-platform | `iscommentline()` | 3 | 4 | 8 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `0cc23f91d72e` | 2 | 01-api | `journal` | 3 | 4 | 8 | **no** | — | `apps\api\scripts\verify-pe-budget-phase-4-negative-controls.ts` |
| `3f5daadd604a` | CleanUp3 | 01-api | `jsonresponse()` | 2 | 8 | 8 | yes | — | `apps\api\src\engagement\google\gmail-send.service.spec.ts` |
| `b6c8b2349eba` | CleanUp3 | 02-web | `legacy` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.award-dates.test.tsx` |
| `7f0705105932` | 1 | 02-web | `line_type_keys` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `edc48ac41aef` | 1 | 01-api | `listchangedpaths()` | 2 | 8 | 8 | yes | — | `apps\api\scripts\verify-pe-phase-10.ts` |
| `65a181a146ab` | 1 | 02-web | `managedimportrow` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\admin\CustomersPage.tsx` |
| `ec78484ea26e` | 1 | 02-web | `markrow` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `8aeffa457fdb` | 1 | 01-api | `measurement` | 2 | 8 | 8 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.ts` |
| `403593e00c5a` | CleanUp3 | 01-api | `memberrow` | 2 | 8 | 8 | yes | — | `apps\api\scripts\dedupe-pe-observations.spec.ts` |
| `d158cc6feeac` | 1 | 02-web | `meriskilldef` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `85f0eef4c241` | CleanUp3 | 05-strategy | `missionrec` | 2 | 8 | 8 | yes | — | `apps\api-strategy\src\agents\outbox-consumer.service.spec.ts` |
| `a37bdf89eaa4` | CleanUp3 | 02-web | `mocks` | 2 | 8 | 8 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `b52535c2b963` | 1 | 01-api | `named_entities` | 2 | 8 | 8 | yes | — | `apps\api\scripts\sync-rss-intel.ts` |
| `d182644c211a` | 1 | 01-api | `nonblank` | 3 | 4 | 8 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-canonical-projection-plan-v1.ts` |
| `8ec8ae428972` | 1 | 02-web | `notice_type_color` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\ProcurementActivityPanel.tsx` |
| `9bbe4caddb53` | 1 | 08-platform | `ok()` | 3 | 4 | 8 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `d1547de4d224` | 1 | 08-platform | `optional()` | 3 | 4 | 8 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `678bd49495be` | 1 | 01-api | `optionalinstant()` | 2 | 8 | 8 | yes | — | `apps\api\src\meri\meri-debrief-read.helpers.ts` |
| `e3000378eed5` | 1 | 01-api | `parsedargs` | 2 | 8 | 8 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `1faba998b91b` | 1 | 02-web | `patchparams()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusPage.tsx` |
| `476ce68e2828` | CleanUp3 | 01-api | `pe` | 9 | 1 | 8 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\actions\appropriations-action-v1.spec.ts` |
| `cdaa243c7128` | 1 | 01-api | `pickfields()` | 2 | 8 | 8 | yes | — | `apps\api\src\external\tango\tango-budget.mapper.ts` |
| `6fda2eb043c6` | 2 | 01-api | `positiveinteger()` | 2 | 8 | 8 | **no** | — | `apps\api\scripts\backfill-canonical-entities.ts` |
| `1f8657ef8ae1` | 2 | 02-web | `primarycell()` | 2 | 8 | 8 | **no** | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `2a6ea70b3162` | 1 | 02-web | `props` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `ceb658f90c75` | 1 | 02-web | `props` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\CapabilityDrawer.tsx` |
| `692c310620f1` | 1 | 04-meri | `recentusercontext()` | 2 | 8 | 8 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-governed-tool-selection.ts` |
| `14ad63076a81` | 1 | 02-web | `registranthit` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\FirmOnboardingWizard.tsx` |
| `d3a4e4010f48` | 1 | 02-web | `rel_meta` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\BudgetLinePanels.tsx` |
| `5e8e19f6166c` | CleanUp3 | 02-web | `renderwithproviders()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\directory\DistrictDetailView.test.tsx` |
| `6f397d5db359` | 2 | 01-api | `requireenv()` | 2 | 8 | 8 | **no** | — | `apps\api\scripts\smoke-clio-research.ts` |
| `86a7a0aa4a58` | 2 | 04-meri | `requireinternalcontextproxy()` | 2 | 8 | 8 | **no** | — | `apps\meriv2-orchestrator\src\meri\in-editor\in-editor.controller.ts` |
| `b9f22e93b021` | 1 | 08-platform | `result` | 9 | 1 | 8 | yes | — | `scripts\verify-phase8-session10-db.mjs` |
| `28fc78b33975` | 2 | 02-web | `root` | 2 | 8 | 8 | **no** | — | `apps\web\src\components\trust\ContextInspector.a11y-fixture.tsx` |
| `45fccb42a3a5` | 1 | 01-api | `runner()` | 2 | 8 | 8 | yes | — | `apps\api\src\engagement\engagement.service.ts` |
| `6d4218f4a209` | 1 | 05-strategy | `safeequalhex()` | 2 | 8 | 8 | yes | — | `apps\api-strategy\src\agents\approval-binding.ts` |
| `2be8a73b4f3b` | 1 | 02-web | `scope` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `64c897f267e7` | CleanUp3 | 02-web | `seriousviolations()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\clients\tracker\tracker-a11y.test.tsx` |
| `ff9ffce95497` | 1 | 08-platform | `servicesecuritygroupid` | 3 | 4 | 8 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `cc516f606d8a` | 2 | 02-web | `sev_color` | 2 | 8 | 8 | **no** | — | `apps\web\src\components\dossier\DossierKpiStrip.tsx` |
| `0b8d496bfc17` | CleanUp3 | 01-api | `sha` | 2 | 8 | 8 | **no** | **yes** | `apps\api\src\defense-budget\verification\budget-verification-repository.spec.ts` |
| `92e293479c30` | 1 | 02-web | `skilltestresponse` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `4b4d84c63389` | 2 | 01-api | `slugifyfilename()` | 2 | 8 | 8 | **no** | — | `apps\api\src\intelligence\artifacts\artifact-generator.service.ts` |
| `e78b238a056e` | 1 | 08-platform | `snapshothash()` | 2 | 8 | 8 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `2a33ecd77636` | 1 | 01-api | `source_family_label` | 2 | 8 | 8 | yes | — | `apps\api\src\live-hearings\legiwatch-analytics.service.ts` |
| `400959a560fc` | CleanUp3 | 02-web | `start()` | 2 | 8 | 8 | yes | — | `apps\web\src\vnext\meri\meri-route-isolation.test.ts` |
| `d434ac38ca74` | 2 | 08-platform | `summary` | 2 | 8 | 8 | **no** | — | `scripts\legiwatch-phase7-qualification.mjs` |
| `a9d01331b871` | 1 | 01-api | `tablekey()` | 2 | 8 | 8 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\conference\appropriations-conference-composer-v1.ts` |
| `5c38902218fd` | 2 | 01-api | `usage()` | 2 | 8 | 8 | **no** | — | `apps\api\scripts\accept-defense-budget-ingestion-review-v1.ts` |
| `4f4d4db0d3e5` | 1 | 02-web | `useclientslite()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\strategy\clients-lite.ts` |
| `76ca7f3db23e` | 1 | 02-web | `usestewardinvalidate()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `faaf24d251ce` | 1 | 02-web | `vehiclesourcecitation()` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\bills\BillFundingTab.tsx` |
| `a9832794de1b` | 1 | 02-web | `wedge_meta` | 2 | 8 | 8 | yes | — | `apps\web\src\pages\program-element\CapabilityFinder.tsx` |
| `7762da95e599` | 2 | 02-web | `wedgechip()` | 2 | 8 | 8 | **no** | — | `apps\web\src\pages\program-element\CapabilityFinder.tsx` |
| `6db3d580141f` | 1 | 01-api | `.projectwhere()` | 2 | 7 | 7 | yes | — | `apps\api\src\defense-research\defense-research.service.ts` |
| `0147d2a9d6d5` | 1 | 06-intel | `.promote()` | 2 | 7 | 7 | yes | — | `apps\intel-api\src\tracker\calendar\agenda-rule.controller.ts` |
| `19456022e22e` | 1 | 01-api | `.resolveprovider()` | 2 | 7 | 7 | yes | — | `apps\api\src\engagement\engagement-ai.service.ts` |
| `911d0d6170ea` | 1 | 02-web | `.viewport()` | 2 | 7 | 7 | yes | — | `apps\web\scripts\engagement-phase3-browser-interactions.mjs` |
| `13258914cc0b` | 3 | 03-defense | `_is_continuation_label()` | 2 | 7 | 7 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\sacd\semantics.py` |
| `733256b4f034` | 3 | 03-defense | `_pendingcontinuation` | 2 | 7 | 7 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\sacd\extractor.py` |
| `17cdc1a7be91` | 1 | 01-api | `activememberrow` | 2 | 7 | 7 | yes | — | `apps\api\src\memory\memory-review-inbox.service.ts` |
| `89536f4905e4` | CleanUp3 | 01-api | `admin` | 2 | 7 | 7 | **no** | — | `apps\api\src\reviews\reviews-outreach.spec.ts` |
| `1e991c899879` | CleanUp3 | 02-web | `apigetmock` | 2 | 7 | 7 | **no** | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `552e103c29b0` | 1 | 02-web | `billlane` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `478a7fbfda25` | 1 | 02-web | `billmetachips()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\bills\BillDossierHero.tsx` |
| `85a2750767da` | 1 | 08-platform | `browserenv()` | 2 | 7 | 7 | yes | — | `scripts\run-engagement-phase1-local.mjs` |
| `ecd9ef66c5fe` | 1 | 02-web | `catalogcategory` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `3dde936c40a5` | 1 | 02-web | `category_labels` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `1c4a2cde43dc` | 1 | 02-web | `cls_label` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\program-element\v2\PeV2Movement.tsx` |
| `063a0ba9bad3` | 1 | 02-web | `committee_label` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `e05aea66a1d0` | 1 | 02-web | `connectstate` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `db808642e74f` | CleanUp3 | 08-platform | `containerenv()` | 2 | 7 | 7 | yes | — | `infra\cdk\test\engagement-api-active-promotion.spec.ts` |
| `96cb8d6ef735` | 1 | 02-web | `createtenantinput` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\capiro-admin\CapiroAdminPage.tsx` |
| `f849f2724ba8` | CleanUp3 | 01-api | `cred` | 2 | 7 | 7 | yes | — | `apps\api\src\engagement\generation\author-style-profile.service.spec.ts` |
| `0562c6dafafe` | CleanUp3 | 01-api | `ctx` | 2 | 7 | 7 | yes | — | `apps\api\src\memory\memory-access-grant.service.spec.ts` |
| `6b6b6d322980` | CleanUp3 | 01-api | `ctx` | 2 | 7 | 7 | **no** | — | `apps\api\src\memory\memory-review-revision.service.spec.ts` |
| `fb0c708fadeb` | CleanUp3 | 01-api | `ctx` | 2 | 7 | 7 | yes | — | `apps\api\src\engagement\engagement-mail-threads.spec.ts` |
| `f384e093989b` | CleanUp3 | 01-api | `ctx` | 2 | 7 | 7 | **no** | — | `apps\api\src\capiro-admin\capiro-admin.service.spec.ts` |
| `b0e31f796d69` | CleanUp3 | 01-api | `ctx` | 2 | 7 | 7 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `ca6a01718e8f` | CleanUp3 | 01-api | `ctxa1` | 2 | 7 | 7 | **no** | — | `apps\api\src\live-hearings\legiwatch-wave2-pg.integration.spec.ts` |
| `b205345b04ca` | CleanUp3 | 01-api | `ctxb1` | 2 | 7 | 7 | **no** | — | `apps\api\src\live-hearings\legiwatch-wave2-pg.integration.spec.ts` |
| `1594af662200` | 1 | 02-web | `dateortext()` | 2 | 7 | 7 | yes | — | `apps\web\src\components\MemoryGovernanceCenter.tsx` |
| `813a459109d2` | 1 | 01-api | `deterministicuuidv1()` | 2 | 7 | 7 | yes | **yes** | `apps\api\scripts\plan-defense-budget-promotion-v1.ts` |
| `a91befe7259e` | 1 | 02-web | `dimmedapp()` | 2 | 7 | 7 | yes | — | `apps\web\src\components\onboarding\OnboardingGates.tsx` |
| `07697e49eaa5` | 1 | 02-web | `escapetext()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\engagement\outreach\v2\RichTextEditor.tsx` |
| `829d2deabf74` | CleanUp3 | 01-api | `evidence` | 2 | 7 | 7 | yes | **yes** | `apps\api\src\defense-budget\verification\budget-verification-repository.spec.ts` |
| `a5e87e6fda0e` | CleanUp3 | 02-web | `evidence` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `2ea83b269d09` | 1 | 01-api | `extractperiodlabel()` | 2 | 7 | 7 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-extractor-v1.ts` |
| `959a74dd1666` | 1 | 02-web | `fundingstagetracklabel()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\bills\BillFundingTab.tsx` |
| `1032f78b9a12` | CleanUp3 | 02-web | `getmock` | 2 | 7 | 7 | **no** | — | `apps\web\src\vnext\pages\client-crm\ManageFacilitiesModal.test.tsx` |
| `806652332944` | 1 | 02-web | `getrawmap()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `17491928af23` | 1 | 08-platform | `git()` | 2 | 7 | 7 | yes | — | `scripts\verify-engagement-phase3-prototype-boundary.mjs` |
| `294be6a7ff03` | 1 | 05-strategy | `internalworkingplannodes()` | 2 | 7 | 7 | yes | — | `apps\api-strategy\src\reports\docx-report.renderer.ts` |
| `6aca7107bfe1` | 1 | 02-web | `invitationrow` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\admin\TeamPage.tsx` |
| `0e4fc4d77a68` | CleanUp3 | 02-web | `job` | 2 | 7 | 7 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioOutputRecovery.test.tsx` |
| `b79cd4d4b1be` | 1 | 02-web | `kind_label` | 2 | 7 | 7 | yes | — | `apps\web\src\vnext\pages\strategies\StepInspector.tsx` |
| `5efd25afd843` | CleanUp3 | 02-web | `kpivalue()` | 2 | 7 | 7 | **no** | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusPage.test.tsx` |
| `683227689483` | CleanUp3 | 01-api | `makeblock()` | 2 | 7 | 7 | yes | **yes** | `apps\api\src\defense-budget\rdte\r2\r2-segmentation.spec.ts` |
| `1c91d31b6d41` | 1 | 01-api | `officialkey()` | 2 | 7 | 7 | yes | — | `apps\api\scripts\ingest-florida-legislative-directories.ts` |
| `b91b7f9530e4` | 1 | 01-api | `optionaltext()` | 2 | 7 | 7 | yes | — | `apps\api\src\meri\meri-action-item-read.helpers.ts` |
| `9463c8e8f4b4` | 1 | 01-api | `optionaltext()` | 2 | 7 | 7 | yes | — | `apps\api\src\meri\meri-debrief-read.helpers.ts` |
| `03ad9777a2a8` | 1 | 03-defense | `parsepositiveinteger()` | 2 | 7 | 7 | yes | — | `apps\defense-parser-orchestrator\src\real-batch-config.mjs` |
| `b3e9ab6a3642` | 1 | 04-meri | `percentile()` | 2 | 7 | 7 | yes | — | `packages\meriv2-core\src\jev\evaluation\bd-task-gate.ts` |
| `aea03a569656` | 1 | 02-web | `primarytab` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `a741688c58ed` | 1 | 08-platform | `prismamigrate()` | 2 | 7 | 7 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `b757bb3284f6` | 1 | 08-platform | `prismavalidate()` | 2 | 7 | 7 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `e7ffa229498c` | 1 | 01-api | `readstatus()` | 2 | 7 | 7 | yes | — | `apps\api\src\external\tango\tango-capability-probe.service.ts` |
| `2f5b14480efe` | 1 | 02-web | `referenceforkrow` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\strategy\types.ts` |
| `be08d91008ed` | 1 | 08-platform | `requirecommand()` | 2 | 7 | 7 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `01e73d4ac268` | CleanUp3 | 04-meri | `result` | 2 | 7 | 7 | **no** | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-research-director.integration.spec.ts` |
| `1b9882574b99` | 1 | 08-platform | `root` | 2 | 7 | 7 | yes | — | `scripts\verify-engagement-phase3-prototype-boundary.mjs` |
| `fa2a662828af` | 2 | 01-api | `rules` | 2 | 7 | 7 | **no** | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-phase5-gates-v1.ts` |
| `8764498f0aba` | 1 | 01-api | `scopekey()` | 2 | 7 | 7 | yes | **yes** | `apps\api\src\defense-budget\om\om-reconciliation-v1.ts` |
| `9cd31a138b57` | 1 | 08-platform | `stripcomments()` | 2 | 7 | 7 | yes | — | `scripts\verify-phase8-session3-admin-boundary.mjs` |
| `49f15eafe46f` | 1 | 08-platform | `summary` | 2 | 7 | 7 | yes | — | `scripts\legiwatch-phase5-qualification.mjs` |
| `f89c170af5e3` | CleanUp3 | 01-api | `target` | 2 | 7 | 7 | yes | — | `apps\api\scripts\lib\memory-phase2-persistence-contract.spec.ts` |
| `3e792d3ccb59` | 3 | 03-defense | `test_missing_page_fails_the_parser_runtime_contract()` | 2 | 7 | 7 | **no** | — | `apps\defense-budget-parser\tests\test_hasc_stage_extractor.py` |
| `e12d3638e027` | 1 | 02-web | `titlefor()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `39a012b031c3` | 1 | 02-web | `toggleartifacts()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `d77df5f569f2` | 1 | 02-web | `togglecoverage()` | 2 | 7 | 7 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `c40336ee39e4` | 2 | 01-api | `usage()` | 2 | 7 | 7 | **no** | — | `apps\api\scripts\promote-procurement-lines.ts` |
| `c762501cf578` | 1 | 08-platform | `usage()` | 2 | 7 | 7 | yes | — | `scripts\lib\verify-engagement-api-task-config-legacy.mjs` |
| `9711fb09322b` | CleanUp3 | 02-web | `usemeetinglibrarymock` | 2 | 7 | 7 | **no** | — | `apps\web\src\pages\engagement\meetings\MeetingLibraryView.test.tsx` |
| `fc035d5220d4` | CleanUp3 | 01-api | `usera` | 2 | 7 | 7 | yes | — | `apps\api\src\engagement\engagement-owner-isolation.spec.ts` |
| `49cc149502c0` | CleanUp3 | 06-intel | `watchlisttopicrow` | 2 | 7 | 7 | yes | — | `apps\intel-api\src\tracker\federal-bill-change-detector.spec.ts` |
| `865bad1fb1af` | 3 | 08-platform | `write_json()` | 2 | 7 | 7 | yes | — | `scripts\meri-synthetic-cohort.py` |
| `322d4457646a` | 1 | 06-intel | `.configured()` | 3 | 3 | 6 | yes | — | `apps\intel-api\src\hearing\client-brief-context.client.ts` |
| `25fe6efeaf28` | 1 | 01-api | `.daterange()` | 2 | 6 | 6 | yes | — | `apps\api\src\capiro-admin\capiro-admin.service.ts` |
| `234fb2218d7a` | 1 | 01-api | `.disconnect()` | 2 | 6 | 6 | yes | — | `apps\api\src\engagement\google\google-oauth.controller.ts` |
| `71488b4efd6d` | 2 | 01-api | `.enabled()` | 3 | 3 | 6 | **no** | — | `apps\api\src\embeddings\client-kb.service.ts` |
| `460eb509f5a5` | 2 | 01-api | `.get()` | 3 | 3 | 6 | **no** | — | `apps\api\src\clients\clients.controller.ts` |
| `9c2a4341515a` | CleanUp3 | 01-api | `.insert()` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `eb4bc050567f` | CleanUp3 | 01-api | `.persistcompletedverification()` | 2 | 6 | 6 | **no** | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `31b403a76109` | 1 | 01-api | `.status()` | 3 | 3 | 6 | yes | — | `apps\api\src\meri\connectors\chat.connector.ts` |
| `01f93d5dd802` | 3 | 03-defense | `.test_config_sha_is_deterministic()` | 2 | 6 | 6 | yes | — | `apps\defense-budget-parser\tests\test_camelot_engine.py` |
| `a9e5f3f87e06` | 3 | 03-defense | `.validate_sha()` | 2 | 6 | 6 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\ndaa_conference\contracts.py` |
| `992256d79258` | 3 | 03-defense | `_to_decimal_string()` | 2 | 6 | 6 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\camelot_engine.py` |
| `7a35051ab4c6` | 1 | 02-web | `actionstyle` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `c6a25b9369f4` | 1 | 02-web | `actiontone()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `559288148ddb` | CleanUp3 | 04-meri | `actor` | 2 | 6 | 6 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-authenticated-context.spec.ts` |
| `04cb1679513f` | CleanUp3 | 01-api | `anthropicjudgeresponse()` | 2 | 6 | 6 | **no** | — | `apps\api\src\intelligence\alert-memo\alert-memo-held-gate.spec.ts` |
| `907a5de879dc` | CleanUp3 | 02-web | `apipostmock` | 2 | 6 | 6 | **no** | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `3ffe29384f6d` | 1 | 01-api | `arg()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\generate-actions.ts` |
| `16d3a3078e26` | 1 | 02-web | `array()` | 3 | 3 | 6 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `ce5f4958942c` | CleanUp3 | 01-api | `artifactbytesha()` | 3 | 3 | 6 | yes | **yes** | `apps\api\src\defense-budget\rdte\cycle\r1-r2-reconciliation-bridge.spec.ts` |
| `2b556cfaa310` | 1 | 02-web | `artifacttypelabel()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `5732e2f0000a` | CleanUp3 | 01-api | `as_of` | 3 | 3 | 6 | **no** | — | `apps\api\src\funding-opportunities\funding-opportunity-outcome.spec.ts` |
| `4d1385e7e6d8` | 1 | 02-web | `avatar_colors` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProgramTeamPanel.tsx` |
| `dfeb788d327a` | CleanUp3 | 01-api | `b64url()` | 3 | 3 | 6 | yes | — | `apps\api\src\engagement\google\gmail-body-extract.spec.ts` |
| `30d14b59bc32` | 1 | 02-web | `band_label` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProgramsPanel.tsx` |
| `768ed6735eb3` | CleanUp3 | 01-api | `baserequest()` | 2 | 6 | 6 | **no** | — | `apps\api\src\retrieval\retrieval-scoring-signals.spec.ts` |
| `064d0bb3ca1f` | CleanUp3 | 06-intel | `bill()` | 2 | 6 | 6 | yes | — | `apps\intel-api\test\bill-fit-routing.spec.ts` |
| `ed60f82a92f1` | 1 | 06-intel | `bounded()` | 2 | 6 | 6 | yes | — | `apps\intel-api\src\hearing\capture\public-capture-automatic-resolver.adapter.ts` |
| `53ef104446ed` | 1 | 01-api | `boundederror()` | 2 | 6 | 6 | yes | — | `apps\api\src\live-hearings\phase9\legiwatch-phase9-central-discovery.service.ts` |
| `6e7ad924a0f7` | 1 | 06-intel | `boundederror()` | 3 | 3 | 6 | yes | — | `apps\intel-api\src\hearing\capture\public-capture-automatic-resolver.adapter.ts` |
| `592893c5b518` | 2 | 01-api | `canonicaldecimal` | 3 | 3 | 6 | **no** | **yes** | `apps\api\src\defense-budget\promotion\manual-override-v1.ts` |
| `dc7c2b9eccb4` | 1 | 02-web | `chamberlabel()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `bea428f7acfa` | 1 | 02-web | `change_tone` | 2 | 6 | 6 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\BillUpdatesDrawer.tsx` |
| `5cd49558a78d` | 1 | 02-web | `color_class` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\engagement\outreach\v2\ui\Badge.tsx` |
| `b432d478ed24` | 1 | 02-web | `colorforratio()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\MarkupMonitorPage.tsx` |
| `e9dab0ef261f` | CleanUp3 | 01-api | `column()` | 4 | 2 | 6 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `7d7f53499d80` | 1 | 08-platform | `completearn()` | 2 | 6 | 6 | yes | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `5400942c8866` | 1 | 02-web | `contactusecolor()` | 3 | 3 | 6 | yes | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `f2f7937fab82` | CleanUp3 | 04-meri | `context` | 2 | 6 | 6 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy.controller.assurance.spec.ts` |
| `083e13621f12` | CleanUp3 | 04-meri | `ctx` | 2 | 6 | 6 | **no** | — | `apps\meriv2-orchestrator\src\meri\meri-capability-contract.spec.ts` |
| `b44a06375ad1` | CleanUp3 | 04-meri | `ctx` | 2 | 6 | 6 | **no** | — | `apps\meriv2-orchestrator\src\meri\meriv3\status-provenance-runtime.spec.ts` |
| `d138ec7d10a1` | CleanUp3 | 04-meri | `currentturn` | 2 | 6 | 6 | yes | — | `apps\meriv2-orchestrator\src\meri\api-action-proposal.repo.spec.ts` |
| `de41d871cbe4` | 1 | 02-web | `cx()` | 3 | 3 | 6 | yes | — | `apps\web\src\pages\engagement\outreach\v3\ContextReviewSurface.tsx` |
| `6af10cce6b3f` | 1 | 02-web | `datekey()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `9e1a09a61864` | 1 | 02-web | `descriptionfor()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `db147c867460` | 1 | 02-web | `displayname()` | 2 | 6 | 6 | yes | — | `apps\web\src\components\chat\MeriWorkspaceWindow.tsx` |
| `5aa2f8b1686c` | 1 | 02-web | `dollarscompact()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ContractorsPanel.tsx` |
| `dbc15c617e69` | 1 | 08-platform | `eq()` | 2 | 6 | 6 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `49cddcaf97ba` | 1 | 02-web | `errormessage()` | 2 | 6 | 6 | yes | — | `apps\web\src\vnext\pages\workspace\hillday\HillDayEditor.tsx` |
| `67730550fc8e` | 1 | 02-web | `eventcluster` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `d7fd9c0b0898` | 1 | 02-web | `eyebrowfor()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `d58474d4e6e7` | 2 | 02-web | `fact_state_tone` | 2 | 6 | 6 | **no** | — | `apps\web\src\pages\strategy\context\StewardReview.tsx` |
| `7239908c16f6` | 1 | 08-platform | `fail()` | 3 | 3 | 6 | yes | — | `scripts\ci\verify-funding-indexes.mjs` |
| `3ad27b0669c8` | 1 | 08-platform | `failed` | 4 | 2 | 6 | yes | — | `scripts\validate-knowledge-plane-phase26.mjs` |
| `18334a198dd6` | CleanUp3 | 01-api | `fake` | 2 | 6 | 6 | yes | — | `apps\api\src\meri\meri-bill-status-tool.spec.ts` |
| `157d3c507ae2` | CleanUp3 | 01-api | `fakehash()` | 3 | 3 | 6 | yes | **yes** | `apps\api\scripts\replace-defense-budget-candidate-approvals-v1.integration.spec.ts` |
| `0f69d4d547a0` | CleanUp3 | 02-web | `file()` | 2 | 6 | 6 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioGovernedInteractions.test.tsx` |
| `fb219abd7bc9` | 1 | 01-api | `fmtm()` | 3 | 3 | 6 | yes | — | `apps\api\src\program-element\intelligence\budget-anomaly.ts` |
| `9226406ed208` | 1 | 03-defense | `fmtm()` | 3 | 3 | 6 | yes | — | `packages\defense-domain\src\pe-read\intelligence\budget-anomaly.ts` |
| `fc244428e3bc` | 2 | 02-web | `focusable()` | 3 | 3 | 6 | **no** | — | `apps\web\src\vnext\pages\funding-opportunities\FundingOpportunityV2ExternalConfirmation.tsx` |
| `18b7a7829488` | 1 | 02-web | `formatawarddate()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `9ad61d66e1c1` | 1 | 02-web | `formatdeadline()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\actions\ActionCard.tsx` |
| `3995f40094b7` | 1 | 02-web | `formatreviewed()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProgramsPanel.tsx` |
| `d469188a55f3` | 1 | 02-web | `formattouch()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `5407739ffbd6` | 1 | 02-web | `futurerow` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictFederalMarketPanel.tsx` |
| `5886e6e9b995` | 1 | 01-api | `gaterule` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-phase5-gates-v1.ts` |
| `17dab7b7d3a8` | CleanUp3 | 02-web | `getmock` | 2 | 6 | 6 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\AdvocacyMattersTab.test.tsx` |
| `30610ba3bbb0` | 1 | 02-web | `getrawarray()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `db6f4201fd95` | 1 | 08-platform | `git()` | 3 | 3 | 6 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `07858a1a3894` | 2 | 07-workspace-onboard | `healthcontroller` | 2 | 6 | 6 | **no** | — | `apps\onboard-api\src\health\health.controller.ts` |
| `3e5cb840115c` | 1 | 02-web | `helpcategory` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\help\HelpPage.tsx` |
| `b9db9a19132c` | CleanUp3 | 01-api | `identity()` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\phase10b2c-certification-bridge-integration.spec.ts` |
| `5e63abea0a10` | 2 | 02-web | `initials()` | 2 | 6 | 6 | **no** | — | `apps\web\src\components\chat\MeriWorkspaceWindow.tsx` |
| `2b8ff6f51368` | 1 | 02-web | `initials()` | 2 | 6 | 6 | yes | — | `apps\web\src\components\AppShell.tsx` |
| `da1cbd1a78b5` | CleanUp3 | 01-api | `intentinput` | 2 | 6 | 6 | yes | — | `apps\api\src\engagement\outreach-send-attachment-integrity.spec.ts` |
| `b0b5f5dfa010` | 1 | 02-web | `isforbidden()` | 3 | 3 | 6 | yes | — | `apps\web\src\vnext\pages\strategies\context\ContextDocumentVNext.tsx` |
| `937cdddd6177` | 1 | 01-api | `isjsonobject()` | 3 | 3 | 6 | yes | — | `apps\api\src\knowledge\episodes\knowledge-episode.repository.ts` |
| `e527fed1c00b` | 1 | 02-web | `isovalue()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\radar\live-hearings\LiveHearingsCanonicalSurface.tsx` |
| `911b75cf66d5` | 1 | 08-platform | `istestfile()` | 3 | 3 | 6 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `ced67a2846fb` | CleanUp3 | 01-api | `jsonresponse()` | 3 | 3 | 6 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo-held-gate.spec.ts` |
| `8164908631f9` | 1 | 04-meri | `latestusertext()` | 2 | 6 | 6 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-managed-mcp-assistant.service.ts` |
| `a4dbb56a91d5` | CleanUp3 | 02-web | `locationsearch()` | 3 | 3 | 6 | yes | — | `apps\web\src\vnext\pages\engagement\VNextMeetingLibrary.test.tsx` |
| `372338693cde` | 2 | 01-api | `main()` | 3 | 3 | 6 | **no** | — | `apps\api\scripts\sync-district-economic-acs.ts` |
| `fb35d3ed12fc` | 1 | 02-web | `mergequeueresponse` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\capiro-admin\CapiroAdminPage.tsx` |
| `0ec6def73e5a` | 1 | 02-web | `mergesegments()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `f8f17f1e2a14` | 1 | 01-api | `missingstatus()` | 3 | 3 | 6 | yes | — | `apps\api\src\context\strategy-context-plane.service.ts` |
| `ddafe34c78a4` | 2 | 01-api | `nextfindingid()` | 3 | 3 | 6 | **no** | **yes** | `apps\api\src\defense-budget\milcon\milcon-verification-policy-v1.ts` |
| `1adbf1dacd26` | 1 | 01-api | `nonblankstring` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\contracts\adapters\adapter-context.ts` |
| `ad69d098f6ad` | 1 | 01-api | `normalizewhitespace()` | 3 | 3 | 6 | yes | **yes** | `apps\api\src\defense-budget\rdte\r2a\r2a-project-section-extractor.ts` |
| `9f925fbe38bb` | 2 | 05-strategy | `normalizewhitespace()` | 3 | 3 | 6 | **no** | — | `apps\api-strategy\src\agents\approval-binding.ts` |
| `6cabfb31f4d8` | CleanUp3 | 02-web | `note` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `528b2a1a4bb9` | CleanUp3 | 01-api | `now` | 2 | 6 | 6 | yes | — | `apps\api\src\intelligence\coverage\coverage-gap.service.spec.ts` |
| `d42bfd04b183` | 1 | 01-api | `object()` | 3 | 3 | 6 | yes | — | `apps\api\src\meri\meri-chat-attachment-transport.ts` |
| `fcce21fe9290` | CleanUp3 | 01-api | `offices()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\sync-legistorm-directory.spec.ts` |
| `d71229c53b1c` | 1 | 08-platform | `ok()` | 3 | 3 | 6 | yes | — | `scripts\check-evaluation-new-bypasses.mjs` |
| `5dcb1be20c3b` | 1 | 01-api | `parseargs()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\match-contractor-identifiers.ts` |
| `cc28dc1c4e70` | 1 | 03-defense | `parseboolean()` | 2 | 6 | 6 | yes | — | `apps\defense-parser-orchestrator\src\real-async.mjs` |
| `94be2eabdaba` | 1 | 01-api | `positiveinteger()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\drain-mailbox-knowledge.ts` |
| `abf8a0267b98` | CleanUp3 | 02-web | `post` | 4 | 2 | 6 | **no** | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `dfd648a789be` | CleanUp3 | 02-web | `postmock` | 2 | 6 | 6 | **no** | — | `apps\web\src\vnext\pages\client-crm\ManageFacilitiesModal.test.tsx` |
| `c60ba3961a58` | 1 | 01-api | `prisma` | 2 | 6 | 6 | yes | — | `apps\api\scripts\diag-state-crosswalk-coverage.ts` |
| `c9745985e3ad` | CleanUp3 | 04-meri | `probabilities` | 2 | 6 | 6 | **no** | — | `packages\meriv2-core\src\jev\calibrated-cascade.spec.ts` |
| `104fae4ebfb9` | 1 | 02-web | `props` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `74b33f2370d7` | 1 | 03-defense | `providerenv` | 2 | 6 | 6 | yes | — | `apps\defense-api\scripts\job.mjs` |
| `0c280afa257d` | 1 | 02-web | `providers` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `df1c9ebe20e6` | 1 | 02-web | `queueresponse` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\admin\PeReconciliationPage.tsx` |
| `83d672fd9420` | 1 | 03-defense | `rawsqlexecutor` | 3 | 3 | 6 | yes | — | `apps\defense-api\src\budget-lifecycle\discovery\prisma-discovery-audit.store.ts` |
| `d91dfb4011b3` | CleanUp3 | 01-api | `read()` | 3 | 3 | 6 | yes | — | `apps\api\scripts\lib\memory-phase2-persistence-contract.spec.ts` |
| `a73241ad5823` | 1 | 01-api | `readbody()` | 2 | 6 | 6 | yes | — | `apps\api\src\external\tango\tango-capability-probe.service.ts` |
| `976d9ccae7f4` | 1 | 01-api | `redacterror()` | 2 | 6 | 6 | yes | — | `apps\api\src\knowledge\episodes\knowledge-episode.repository.ts` |
| `dc383d1ecf3d` | CleanUp3 | 01-api | `request` | 2 | 6 | 6 | **no** | — | `apps\api\src\retrieval\retrieval-v2-reranking.spec.ts` |
| `12f4a0d5a282` | CleanUp3 | 01-api | `request()` | 2 | 6 | 6 | yes | — | `apps\api\src\retrieval\adapters\core-prisma-security-scope.spec.ts` |
| `86b883a4b5e8` | 1 | 08-platform | `resolvecommand()` | 2 | 6 | 6 | yes | — | `scripts\run-engagement-phase1-local.mjs` |
| `111730b07ed1` | CleanUp3 | 02-web | `resolvegenerate()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `d10895f6d13b` | CleanUp3 | 02-web | `resolvegetfallback()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\directory\DirectoryMemberProfileModal.test.tsx` |
| `4d120e14d343` | 1 | 08-platform | `results` | 4 | 2 | 6 | yes | — | `scripts\legiwatch-phase5-qualification.mjs` |
| `d25096b8572b` | CleanUp3 | 01-api | `scope` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-service-v1.spec.ts` |
| `53580f5dad3a` | 1 | 01-api | `searchdto` | 2 | 6 | 6 | yes | — | `apps\api\src\federal-spending\federal-spending.controller.ts` |
| `2fed6d77eca8` | 1 | 02-web | `searchmode` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `3bfc8d38001e` | 1 | 02-web | `semanticcriteria()` | 2 | 6 | 6 | yes | — | `apps\web\src\vnext\pages\funding-opportunities\FundingOpportunitiesPage.tsx` |
| `cbdfc1015f82` | 1 | 01-api | `setcontext()` | 4 | 2 | 6 | yes | — | `apps\api\scripts\verify-memory-admin-self-approval-database.ts` |
| `35ced60fd2fe` | 1 | 02-web | `sevforstate()` | 2 | 6 | 6 | yes | — | `apps\web\src\components\dossier\EventTimeline.tsx` |
| `12462fbcdbc3` | CleanUp3 | 01-api | `sha` | 4 | 2 | 6 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-verification-wiring.spec.ts` |
| `a87cc86a9682` | 1 | 01-api | `sha256()` | 3 | 3 | 6 | yes | — | `apps\api\scripts\seed-engagement-phase3-parity-fixtures.ts` |
| `a6ab1844aa8f` | 1 | 01-api | `sha256()` | 3 | 3 | 6 | yes | — | `apps\api\scripts\embed-backfill.ts` |
| `f6fbcb97680c` | 1 | 01-api | `sha256file()` | 3 | 3 | 6 | yes | — | `apps\api\scripts\extract-defense-budget-cycle.ts` |
| `70518a9734a8` | CleanUp3 | 01-api | `shellcode()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\legiwatch-phase9-entrypoint.spec.ts` |
| `ff7d06694b13` | 1 | 02-web | `shortdate()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\program-element\ProcurementActivityPanel.tsx` |
| `5cb1fc940130` | 1 | 02-web | `simulationformvalues` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\settings\PolicyPacksPage.tsx` |
| `8cf569daada0` | 1 | 08-platform | `sleep()` | 3 | 3 | 6 | yes | — | `scripts\package9-product-query-benchmark.mjs` |
| `475148d411b6` | CleanUp3 | 01-api | `sql()` | 2 | 6 | 6 | yes | — | `apps\api\src\prisma\legiwatch-live-hearings-foundation-migration.spec.ts` |
| `e670f8cd6d2b` | CleanUp3 | 01-api | `staff()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\sync-legistorm-directory.spec.ts` |
| `45c9a7aebcd6` | CleanUp3 | 08-platform | `statement` | 2 | 6 | 6 | yes | — | `infra\cdk\test\engagement-api-active-promotion.spec.ts` |
| `ef8f50e9615e` | 1 | 01-api | `statepayload` | 2 | 6 | 6 | yes | — | `apps\api\src\engagement\google\google-oauth.service.ts` |
| `4949eaa2e78e` | 1 | 04-meri | `stringsfrom()` | 2 | 6 | 6 | yes | — | `apps\meriv2-orchestrator\src\meri\retrieval\meri-federal-market-signals.ts` |
| `0bf20f681f18` | CleanUp3 | 01-api | `stripcomments()` | 3 | 3 | 6 | yes | — | `apps\api\src\business-development\bizdev-watch.invariant.spec.ts` |
| `60c59731719d` | CleanUp3 | 05-strategy | `stubprisma()` | 2 | 6 | 6 | yes | — | `apps\api-strategy\src\firm-phases\firm-phases.service.spec.ts` |
| `d6f60848cae9` | 1 | 02-web | `tab_copy` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `8278a881181b` | CleanUp3 | 01-api | `target` | 2 | 6 | 6 | yes | **yes** | `apps\api\src\defense-budget\promotion\manual-override-repository-prisma-v1.spec.ts` |
| `23f653995902` | CleanUp3 | 01-api | `tenantid` | 3 | 3 | 6 | yes | — | `apps\api\src\business-development\bizdev-brief.service.spec.ts` |
| `0cebaba0ac04` | 1 | 02-web | `tenantmember` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\strategy\members.ts` |
| `9768f4493a28` | 3 | 03-defense | `test_missing_physical_page_is_explicitly_omitted()` | 2 | 6 | 6 | **no** | — | `apps\defense-budget-parser\tests\test_hacd_stage_extractor.py` |
| `6416d5c0c0c9` | 3 | 03-defense | `test_replay_is_deterministic()` | 2 | 6 | 6 | **no** | — | `apps\defense-budget-parser\tests\test_hasc_stage_extractor.py` |
| `481d98db9515` | 1 | 02-web | `text()` | 3 | 3 | 6 | yes | — | `apps\web\src\components\chat\meri-client-save-receipt.ts` |
| `041b0575e659` | CleanUp3 | 05-strategy | `todayiso` | 2 | 6 | 6 | yes | — | `apps\api-strategy\src\agents\watch-review.service.spec.ts` |
| `f09306c8904f` | 1 | 01-api | `uniquesorted()` | 3 | 3 | 6 | yes | — | `apps\api\src\outreach-v3\generation\outreach-v3-generation-approach.ts` |
| `eefeb801e8eb` | 1 | 01-api | `uniquestrings()` | 3 | 3 | 6 | yes | — | `apps\api\src\context\context-resolver.service.ts` |
| `ac1dd5c4f664` | CleanUp3 | 02-web | `useclientoptionsmock` | 2 | 6 | 6 | **no** | — | `apps\web\src\pages\engagement\meetings\MeetingLibraryView.test.tsx` |
| `9615846985ce` | 1 | 01-api | `validdate()` | 3 | 3 | 6 | yes | — | `apps\api\src\live-hearings\phase9\legiwatch-phase9-cutover.service.ts` |
| `0c5c61121812` | 1 | 02-web | `verification_label` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `109120ecf1d7` | 2 | 02-web | `viewports` | 4 | 2 | 6 | **no** | — | `apps\web\scripts\engagement-phase0-browser-acceptance.mjs` |
| `4a254edb88ad` | CleanUp3 | 06-intel | `watchlisttermrow` | 2 | 6 | 6 | yes | — | `apps\intel-api\src\tracker\federal-bill-change-detector.spec.ts` |
| `95d6083bc380` | 1 | 02-web | `watchstatekey()` | 3 | 3 | 6 | yes | — | `apps\web\src\pages\strategy\agents\StrategyWatchPanel.tsx` |
| `eb8fd535c740` | 1 | 01-api | `withbypass()` | 2 | 6 | 6 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `a857dab69358` | 1 | 07-workspace-onboard | `write()` | 2 | 6 | 6 | yes | — | `apps\onboard-api\src\auth\org-tenant-resolver.provider.ts` |
| `217377ac202a` | 1 | 02-web | `wsurl()` | 2 | 6 | 6 | yes | — | `apps\web\src\pages\intelligence\HearingRoomComposition.tsx` |
| `c940633766c4` | CleanUp3 | 01-api | `.findprojectionidsforcertification()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\phase6\phase6-audit-projection-repository.spec.ts` |
| `d1a342e414a1` | 1 | 05-strategy | `.intx()` | 2 | 5 | 5 | yes | — | `apps\api-strategy\src\agents\execution.service.ts` |
| `492564be155b` | 1 | 01-api | `.normalizepage()` | 2 | 5 | 5 | yes | — | `apps\api\src\capiro-admin\capiro-admin.service.ts` |
| `f957c9e67d4e` | 2 | 07-workspace-onboard | `.publicbaseurl()` | 2 | 5 | 5 | **no** | — | `apps\onboard-api\src\funnel\provisioning.service.ts` |
| `aa119e609ddb` | 1 | 06-intel | `.resolveclosewaiters()` | 2 | 5 | 5 | yes | — | `apps\intel-api\src\hearing\capture\server-deepgram-stream.manager.ts` |
| `3b3d5fc37d85` | 1 | 01-api | `.signstate()` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\google\google-oauth.service.ts` |
| `479afa269556` | 1 | 07-workspace-onboard | `.slotspriceid()` | 2 | 5 | 5 | yes | — | `apps\onboard-api\src\billing\billing.service.ts` |
| `39465e92525a` | 1 | 01-api | `.upsertprogramelement()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\seed-program-element-fixtures.ts` |
| `6c3a1e8daf7e` | 3 | 03-defense | `_printed_page()` | 2 | 5 | 5 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\extractors\stages\hacd\semantics.py` |
| `b572cc6bae56` | 1 | 02-web | `addlocaldays()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\engagement\EngagementPage.tsx` |
| `67e647e7097e` | 1 | 02-web | `apierrorbody` | 2 | 5 | 5 | yes | — | `apps\web\src\vnext\pages\workspace\creation\intake-client.ts` |
| `809365100f4b` | CleanUp3 | 02-web | `apipatchmock` | 2 | 5 | 5 | **no** | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `6a3eb2bb1fba` | 1 | 01-api | `artifact` | 2 | 5 | 5 | yes | — | `apps\api\scripts\load-om-op5.ts` |
| `23df8498649f` | 1 | 02-web | `artifact_labels` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\engagement\meetings\SharedMeetingsSection.tsx` |
| `b38839f59a6e` | 1 | 01-api | `asobject()` | 2 | 5 | 5 | yes | — | `apps\api\src\knowledge\entities\canonical-entity-registration.repository.ts` |
| `0cdc1a13fb8e` | 1 | 02-web | `asrecord()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\chat\meri-http-error.ts` |
| `7d1ec8d214ef` | 1 | 05-strategy | `asrecord()` | 2 | 5 | 5 | yes | — | `apps\api-strategy\src\reports\member-office.reader.ts` |
| `91bd84ff9708` | 1 | 01-api | `assertionmetadata` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `aa8baac8f80d` | 1 | 02-web | `auth_label` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `cea35fe2ad36` | CleanUp3 | 02-web | `authority` | 6 | 1 | 5 | **no** | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioDetailPage.interactions.test.tsx` |
| `04919a271cfc` | 1 | 02-web | `avatarcolor()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\ProgramTeamPanel.tsx` |
| `33ebcd3c2e82` | 2 | 02-web | `band_meta` | 2 | 5 | 5 | **no** | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `85cc0c90f6a8` | 1 | 08-platform | `base` | 2 | 5 | 5 | yes | — | `scripts\verify-engagement-phase3-prototype-boundary.mjs` |
| `47c917fd1680` | CleanUp3 | 04-meri | `base_draft_input` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy-assistant.service.spec.ts` |
| `4f0114414c3c` | CleanUp3 | 02-web | `capturedpayload()` | 2 | 5 | 5 | yes | — | `apps\web\src\vnext\pages\research-portfolios\ResearchPortfolioGovernedInteractions.test.tsx` |
| `9f97b3068ded` | 1 | 02-web | `catalogresponse` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `046c4ddeee59` | 1 | 02-web | `catalogtool` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `a3b7a5bea1da` | 1 | 01-api | `claim` | 2 | 5 | 5 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `f4ba0dc431a9` | 1 | 02-web | `clientlite` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `40565d773a5b` | 1 | 02-web | `clientoption` | 2 | 5 | 5 | yes | — | `apps\web\src\components\QuickLog.tsx` |
| `6856221c0e0d` | 1 | 02-web | `clientoption` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusFilters.tsx` |
| `1f8017f6b25d` | CleanUp3 | 01-api | `code()` | 2 | 5 | 5 | yes | — | `apps\api\src\prisma\legiwatch-live-hearings-foundation-migration.spec.ts` |
| `eefc59abe9de` | 3 | 03-defense | `compute_config_sha256()` | 2 | 5 | 5 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\docling_engine.py` |
| `b7aeb57c227f` | CleanUp3 | 04-meri | `config()` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meri-semantic-tool-gateway.spec.ts` |
| `6fd25c88dec2` | 1 | 02-web | `contactlabel()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\LinkCrmContactModal.tsx` |
| `0a2360cd6d02` | CleanUp3 | 01-api | `ctx` | 6 | 1 | 5 | **no** | — | `apps\api\src\district-nexus\r5-action-layer\r5-district-actions.spec.ts` |
| `a50322531423` | 1 | 02-web | `datetext()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\MemoryGovernanceCenter.tsx` |
| `d676efd43dab` | 1 | 01-api | `dedupe()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\generate-grant-opportunity-candidates.ts` |
| `26182739aa0c` | 2 | 02-web | `deltakpicolor()` | 2 | 5 | 5 | **no** | — | `apps\web\src\pages\bills\BillDossierHero.tsx` |
| `cc143a38f8fc` | 1 | 01-api | `emailsendresult` | 2 | 5 | 5 | yes | — | `apps\api\src\tracker\notifications\tracker-email.service.ts` |
| `d103e0b038aa` | 1 | 01-api | `emptytoundefined()` | 2 | 5 | 5 | yes | — | `apps\api\src\capiro-admin\capiro-admin.controller.ts` |
| `09ca54c99293` | CleanUp3 | 01-api | `errorcodes()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\contracts\extraction-artifact-v1.semantic.spec.ts` |
| `9ef164771a05` | 1 | 02-web | `evbadge()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\dossier\EvidenceBadge.tsx` |
| `0397a28f0027` | 1 | 04-meri | `extractimpersonatetenant()` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat.controller.ts` |
| `2ed006f1d17a` | CleanUp3 | 01-api | `filesystemartifactloader` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\governed-acceptance\candidate-correction\phase10b35c-candidate-correction-e2e.integration.spec.ts` |
| `4486dbccf0bf` | 1 | 01-api | `fingerprint()` | 2 | 5 | 5 | yes | — | `apps\api\src\research-portfolios\research-portfolio-review.service.ts` |
| `1f2d39381881` | 1 | 02-web | `formatactiondate()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `e141114f216c` | 1 | 02-web | `formatdate()` | 2 | 5 | 5 | yes | — | `apps\web\src\vnext\pages\strategies\StepInspector.tsx` |
| `11ace29252ef` | 1 | 02-web | `formatdate()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\explorer\bill-detail.tsx` |
| `df94842f0401` | 1 | 03-defense | `gpu` | 2 | 5 | 5 | yes | — | `apps\defense-api\scripts\job.mjs` |
| `f6337a44fc4a` | 1 | 02-web | `greetingfor()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\chat\MeriWorkspaceConversation.tsx` |
| `45e8ed9d2234` | 1 | 02-web | `handleclose()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\LinkCrmContactModal.tsx` |
| `63f399a96608` | 1 | 04-meri | `hasexplicitcompleteness()` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-retrieval-recipe-utils.ts` |
| `3fb8387e0728` | 2 | 08-platform | `head` | 2 | 5 | 5 | **no** | — | `scripts\run-outreach-v3-phase4-local.mjs` |
| `27f8aa30c35f` | CleanUp3 | 01-api | `identity()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `7502918cc202` | 1 | 02-web | `importcandidatesresponse` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\clients\FirmOnboardingWizard.tsx` |
| `79400c8af30a` | 1 | 02-web | `inc_tier` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\BudgetLinePanels.tsx` |
| `0cc75055c51a` | 1 | 07-workspace-onboard | `inlineerrorstyle` | 2 | 5 | 5 | yes | — | `apps\onboard-web\src\pages\funnel\RegisterPage.tsx` |
| `7b892d0ac9f6` | 1 | 02-web | `inputvaluefromdate()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\engagement\EngagementPage.tsx` |
| `4feb4727eae3` | 1 | 01-api | `iso()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\backfill-federal-award-dates.ts` |
| `70984fc8516c` | 2 | 04-meri | `iso()` | 2 | 5 | 5 | **no** | — | `packages\meriv2-core\src\assurance\feedback-fixtures.ts` |
| `21d1d47e4847` | 1 | 01-api | `isodate()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-delta-repository-prisma-v1.ts` |
| `1c2c682504df` | 1 | 01-api | `laterdate()` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `0edd2403f41d` | 1 | 02-web | `linkedrule` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `3b0971dd79a9` | 1 | 02-web | `materialitycolor()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\WhatChangedPanel.tsx` |
| `0bfd019b9b58` | 1 | 04-meri | `mentionsfilename()` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\repair\live-repair.service.ts` |
| `936951ffdb85` | 1 | 01-api | `metadatarecord()` | 2 | 5 | 5 | yes | — | `apps\api\src\common\internal-clio-artifact.ts` |
| `0842dc2ce1c1` | CleanUp3 | 01-api | `money()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\actions\appropriations-action-v1.spec.ts` |
| `b667384c73f9` | 1 | 02-web | `movementmode` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `dbc5823ed23b` | 1 | 01-api | `narrative_sections` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\dd1391\dd1391-extractor-v1.ts` |
| `c920240fbc77` | 1 | 01-api | `normalizedecimal()` | 2 | 5 | 5 | yes | **yes** | `apps\api\scripts\pe-budget-phase7-engine-rehearsal.ts` |
| `c7f35e444df4` | 1 | 01-api | `normalizeset()` | 2 | 5 | 5 | yes | — | `apps\api\src\outreach-v3\state\outreach-campaign-spec.v1.ts` |
| `10389044509f` | 1 | 02-web | `num()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\WhatChangedPanel.tsx` |
| `64d43faba773` | 1 | 01-api | `object()` | 2 | 5 | 5 | yes | — | `apps\api\src\live-hearings\live-hearings-phase7.controller.ts` |
| `3513adec1049` | CleanUp3 | 01-api | `observed_at` | 2 | 5 | 5 | **no** | — | `apps\api\src\learning\adapters\crm-fill-finding.adapter.spec.ts` |
| `0154859ee4b2` | 1 | 05-strategy | `opennodeaction()` | 2 | 5 | 5 | yes | — | `apps\api-strategy\src\agents\watch-review.service.ts` |
| `96a0d9f64f9e` | 1 | 03-defense | `openprisma()` | 2 | 5 | 5 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `130647212fbc` | 1 | 02-web | `outcomerank()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `d3e3053ba903` | CleanUp3 | 04-meri | `pack` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy-assistant.service.spec.ts` |
| `e3bd921e3f87` | CleanUp3 | 02-web | `patchmock` | 2 | 5 | 5 | **no** | — | `apps\web\src\vnext\pages\client-crm\ManageFacilitiesModal.test.tsx` |
| `692252b4f618` | 1 | 02-web | `positionfordate()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `cd6d3ff17297` | CleanUp3 | 02-web | `postmock` | 2 | 5 | 5 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\AdvocacyMattersTab.test.tsx` |
| `6cdf8ac42e40` | 1 | 02-web | `presignedurlresponse` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\admin\BrandingPage.tsx` |
| `16ba8a403a26` | 1 | 02-web | `priority` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\bills\BillDossierHero.tsx` |
| `646537778bde` | CleanUp3 | 01-api | `prismathatmustnotquery` | 2 | 5 | 5 | **no** | — | `apps\api\src\meri\meri-feature-flags.matrix.spec.ts` |
| `7f32351026d9` | CleanUp3 | 01-api | `profile` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\stages\authorization\hasc-composer-v1.spec.ts` |
| `3c8a24907f95` | CleanUp3 | 01-api | `profile` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-composer-v1.spec.ts` |
| `12e2d2723a20` | CleanUp3 | 01-api | `profile` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\sacd\sacd-composer-v1.spec.ts` |
| `1908f93777c0` | CleanUp3 | 01-api | `profile` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\stages\authorization\sasc-composer-v1.spec.ts` |
| `16d0ac8ff9f4` | CleanUp3 | 02-web | `program_search` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `1dcb3489cb57` | 1 | 01-api | `projecttitlerow` | 2 | 5 | 5 | yes | — | `apps\api\src\program-element\matching\pe-program-matcher.service.ts` |
| `39345cab0ab9` | CleanUp3 | 01-api | `proposercontext` | 2 | 5 | 5 | yes | — | `apps\api\src\memory\immutable-memory-version.service.spec.ts` |
| `d926cbdb7c72` | 1 | 02-web | `providercapabilities` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `23ca1948dde8` | 1 | 02-web | `readfy()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\ProgramElementFyDrilldown.tsx` |
| `60f106a6816b` | 1 | 02-web | `reasonmodaltitle()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\MemoryReviewInbox.tsx` |
| `4cbfe399c8ee` | 1 | 02-web | `reasonstate` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\PolicyPacksPage.tsx` |
| `758233199d9d` | 1 | 02-web | `recipientrow` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\SecondaryDistributionPanel.tsx` |
| `ab23d2b30739` | 1 | 02-web | `record()` | 2 | 5 | 5 | yes | — | `apps\web\src\vnext\pages\client-crm\client-fill-review-evidence.ts` |
| `22dc62582863` | 1 | 08-platform | `record()` | 2 | 5 | 5 | yes | — | `packages\shared\src\ai-model-policy.ts` |
| `70bda76ea35a` | 1 | 01-api | `referencefingerprint` | 2 | 5 | 5 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `fe8e6cc2fac7` | 1 | 02-web | `required()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\engagement\outreach\v3\commands.ts` |
| `bb717487fc86` | 1 | 01-api | `role_level` | 2 | 5 | 5 | yes | — | `apps\api\src\research-portfolios\research-portfolio-access.ts` |
| `0a6642fd71d7` | 1 | 01-api | `saferecord()` | 2 | 5 | 5 | yes | — | `apps\api\src\live-hearings\phase9\legiwatch-phase9-readiness.service.ts` |
| `2d2459e09d62` | 1 | 01-api | `samdate()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\sync-sam-opportunities.ts` |
| `3c9c1054c592` | 1 | 01-api | `samepages()` | 2 | 5 | 5 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-semantic-artifact-factory-v1.ts` |
| `c845bc59d6e3` | 1 | 02-web | `saveerrormessage()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\settings\PersonalPage.tsx` |
| `b4e0c69760f9` | CleanUp3 | 04-meri | `schema()` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-research-director-schema-cutover.spec.ts` |
| `300874d9683a` | 1 | 01-api | `shiftdaysutc()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\sync-legistorm-directory.ts` |
| `17a918abe006` | 1 | 02-web | `signalgeography()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictFederalMarketPanel.tsx` |
| `2896db15d797` | 1 | 02-web | `similaritycolor()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\RelatedPesPanel.tsx` |
| `83f237d90549` | 1 | 01-api | `singlesponsorclient()` | 2 | 5 | 5 | yes | — | `apps\api\src\outreach-v3\context\outreach-v3-context.service.ts` |
| `69c213e2b582` | 1 | 02-web | `sourceurlfor()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `9db7c9f795ab` | 1 | 02-web | `stance` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\bills\BillDossierHero.tsx` |
| `2a6f5342b651` | 1 | 02-web | `statelegislatorfacets` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\directory\StateLegislatorDirectory.tsx` |
| `d4b526a49321` | 1 | 01-api | `str()` | 2 | 5 | 5 | yes | — | `apps\api\src\vendor-reference\vendor-reference-sam.client.ts` |
| `8edf440ca541` | 1 | 01-api | `strings()` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\meeting-prep-pdf.ts` |
| `6a3502ad68ca` | CleanUp3 | 01-api | `svc()` | 2 | 5 | 5 | yes | — | `apps\api\src\meri\meri-bill-status-tool.spec.ts` |
| `257116ed20ee` | 1 | 01-api | `syncresult` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `b604aef5b4ef` | CleanUp3 | 01-api | `task` | 2 | 5 | 5 | **no** | — | `apps\api\scripts\run-clio-scheduled-tasks.postgres.spec.ts` |
| `829942e3f22f` | CleanUp3 | 04-meri | `tc` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\meri-context.resolver.spec.ts` |
| `e237342ba606` | CleanUp3 | 04-meri | `tenant` | 2 | 5 | 5 | yes | — | `apps\meriv2-orchestrator\src\meri\strategy\strategy.controller.assurance.spec.ts` |
| `aa14bd00ec34` | 1 | 01-api | `tonullabledate()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\sync-legistorm-districts.ts` |
| `58c916e19fb1` | 1 | 02-web | `tonullablenumber()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `b41f7823d618` | CleanUp3 | 01-api | `tool_schema` | 2 | 5 | 5 | yes | — | `apps\api\src\meri\meri-research-durable-replay.spec.ts` |
| `0dab503e44ee` | 1 | 01-api | `torecord()` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\engagement-ai.service.ts` |
| `69bda9c0aaad` | CleanUp3 | 01-api | `tsx_cli` | 2 | 5 | 5 | yes | — | `apps\api\src\engagement\engagement-route-manifest.spec.ts` |
| `c34b25738fe1` | 1 | 02-web | `valuecolor()` | 2 | 5 | 5 | yes | — | `apps\web\src\components\dossier\DossierKpiStrip.tsx` |
| `313cf293ef60` | 1 | 02-web | `vehicle_color` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\program-element\FundingNarrativePanel.tsx` |
| `d806d8cbc9a3` | 1 | 02-web | `votetargetlabel()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\bills\BillPathVotesTab.tsx` |
| `9f3102bf17e9` | 1 | 01-api | `withfilenewlines()` | 2 | 5 | 5 | yes | — | `apps\api\scripts\verify-pe-budget-phase-3-negative-controls.ts` |
| `fae3cb5697c6` | CleanUp3 | 02-web | `wrapper()` | 2 | 5 | 5 | yes | — | `apps\web\src\pages\strategy\api.watch.test.tsx` |
| `c5633a114650` | 2 | 02-web | `.componentdidcatch()` | 2 | 4 | 4 | **no** | — | `apps\web\src\vnext\pages\client-crm\VNextClientCrmRoute.tsx` |
| `8dbfe1522835` | 1 | 01-api | `.headers()` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\llamaparse.client.spec.ts` |
| `2179bd6ee578` | CleanUp3 | 01-api | `.pausesideeffectdrain()` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-repository-prisma-v1.ts` |
| `46521e3df389` | 1 | 04-meri | `.run()` | 2 | 4 | 4 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-managed-mcp-assistant.service.ts` |
| `d8894eaed823` | 1 | 01-api | `.upsertprogramelementmilestone()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\seed-program-element-fixtures.ts` |
| `6aaaec866833` | 1 | 01-api | `.upsertprogramelementyear()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\seed-program-element-fixtures.ts` |
| `0cc701c31d1f` | 1 | 07-workspace-onboard | `.wireduedays()` | 2 | 4 | 4 | yes | — | `apps\onboard-api\src\funnel\funnel.service.ts` |
| `6d89e0595188` | 1 | 02-web | `actionstate` | 2 | 4 | 4 | yes | — | `apps\web\src\components\MemoryGovernanceCenter.tsx` |
| `3098be47e284` | 1 | 02-web | `actiontypecolor()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `d652fc938087` | 1 | 02-web | `actiontypelabel()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `62f2fdcfc2a2` | 1 | 01-api | `addmoney()` | 2 | 4 | 4 | yes | — | `apps\api\src\district-nexus\district-nexus.aggregate.ts` |
| `d75c09c7d712` | CleanUp3 | 01-api | `allow_legacy` | 2 | 4 | 4 | **no** | — | `apps\api\scripts\lib\pe-exact-sha-loader-contract.spec.ts` |
| `1f26dc11adaf` | CleanUp3 | 02-web | `apideletemock` | 2 | 4 | 4 | **no** | — | `apps\web\src\pages\admin\AnalystConsolePage.test.tsx` |
| `7afecbfd0c9c` | 2 | 08-platform | `apiimagedigest` | 2 | 4 | 4 | **no** | — | `infra\cdk\bin\defense-budget-operations.ts` |
| `a4b0904f37c1` | CleanUp3 | 01-api | `apiroot()` | 2 | 4 | 4 | yes | — | `apps\api\src\outreach-v3\templates\outreach-template.persistence.spec.ts` |
| `579b2389401f` | CleanUp3 | 01-api | `apiroot()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\lib\pe-watch-tenant-isolation.spec.ts` |
| `b982b70df882` | 1 | 01-api | `arg()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\auto-confirm-pe-person-candidates.ts` |
| `196c59fc69ca` | 1 | 01-api | `arg()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\ingest-cpf-cds.ts` |
| `52658bfb34e3` | 1 | 01-api | `argument()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\repair-florida-jlbc-openstates-alias.ts` |
| `62aa03f30dfe` | 1 | 04-meri | `argument()` | 2 | 4 | 4 | yes | — | `packages\meriv2-core\scripts\canary-report.ts` |
| `98e57def24f1` | 1 | 03-defense | `argv` | 3 | 2 | 4 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `449ba774f80b` | 1 | 01-api | `argvalue()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\plan-rdte-canonical-projection.ts` |
| `daad149baa52` | 1 | 01-api | `argvalue()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\sync-jbook-performers.ts` |
| `5e2a7e9780f6` | 1 | 02-web | `artifactversion()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `3eca55639b2d` | 1 | 07-workspace-onboard | `authedfetch()` | 2 | 4 | 4 | yes | — | `apps\onboard-web\src\lib\funnel.ts` |
| `2f9599b8e9af` | 1 | 02-web | `billlabel()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `9f363d7021b9` | 1 | 02-web | `canceledit()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `e7eac44c64cd` | 1 | 02-web | `citationhref()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProofPackPanel.tsx` |
| `b9995be83a8b` | 1 | 01-api | `clean()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `69f87caf2987` | 1 | 02-web | `clientlite` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `0e359e16cc9f` | 1 | 01-api | `clientscope` | 2 | 4 | 4 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `dc5e6fcf1587` | 3 | 03-defense | `compute_config_sha256()` | 2 | 4 | 4 | yes | — | `apps\defense-budget-parser\src\capiro_defense_budget_parser\camelot_engine.py` |
| `109a8427ad87` | 1 | 02-web | `contractorsearchresponse` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\settings\IntelligenceMappingsPage.tsx` |
| `da946b8fa689` | 2 | 08-platform | `corpus` | 2 | 4 | 4 | **no** | — | `scripts\prepare-phase8-session6-federal-funding-corpus.mjs` |
| `dcb0ef740ac3` | CleanUp3 | 01-api | `ctx` | 2 | 4 | 4 | **no** | — | `apps\api\src\ingestion\ai-usage-record.spec.ts` |
| `0fb1257ee2ed` | CleanUp3 | 01-api | `dark` | 2 | 4 | 4 | yes | — | `apps\api\src\memory\memory-candidate.atomicity.spec.ts` |
| `f1cd6eb96e87` | 2 | 01-api | `databaseidentity()` | 2 | 4 | 4 | **no** | — | `apps\api\scripts\verify-memory-phase2-notification-closeout.ts` |
| `cae1c26be63c` | 2 | 01-api | `denied()` | 2 | 4 | 4 | **no** | — | `apps\api\src\memory\synthetic-candidate-withdrawal.helpers.ts` |
| `ddc697ace4bc` | 1 | 01-api | `describeerror()` | 2 | 4 | 4 | yes | — | `apps\api\src\funding-opportunities\tango-event-processor.service.ts` |
| `648e4edd9ab4` | 1 | 02-web | `detailitem` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `8f7367f3fa76` | 2 | 02-web | `divergencerow()` | 2 | 4 | 4 | **no** | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `35c15c43d305` | CleanUp3 | 01-api | `doc()` | 3 | 2 | 4 | yes | **yes** | `apps\api\scripts\validate-defense-budget-cycle-manifest.spec.ts` |
| `a613f3099fd5` | 1 | 02-web | `dollarsmm()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\MarkupMonitorPage.tsx` |
| `b4fb27070484` | 1 | 02-web | `dollarsmm()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `7ca868da8dfb` | 2 | 08-platform | `domainindex` | 2 | 4 | 4 | **no** | — | `scripts\verify-phase8-session8.mjs` |
| `090dfdbb2665` | 1 | 02-web | `emailsignatureresponse` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\settings\PersonalPage.tsx` |
| `3a76fc2af7e8` | 1 | 07-workspace-onboard | `entry` | 2 | 4 | 4 | yes | — | `apps\onboard-api\src\auth\org-tenant-resolver.provider.ts` |
| `240fcb4628bc` | 2 | 01-api | `errorcode()` | 2 | 4 | 4 | **no** | — | `apps\api\src\knowledge\entities\canonical-source-backfill.service.ts` |
| `04a83e48621b` | 1 | 07-workspace-onboard | `escape()` | 2 | 4 | 4 | yes | — | `apps\workspace\src\drafts\editorial-content.ts` |
| `7d0b39fea60e` | 1 | 02-web | `evidencebadge()` | 2 | 4 | 4 | yes | — | `apps\web\src\components\dossier\EvidenceBadge.tsx` |
| `ea18f2d5580c` | 1 | 01-api | `exactkeys()` | 2 | 4 | 4 | yes | — | `apps\api\src\meri\meri-research-child-task.ts` |
| `ac87cb2771dd` | 1 | 01-api | `failure()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.ts` |
| `77b3d6d15241` | CleanUp3 | 04-meri | `fakeprisma` | 2 | 4 | 4 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.spec.ts` |
| `be922f826775` | 1 | 02-web | `favoriterow` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\engagement\outreach\v2\StepRecipientsSelect.tsx` |
| `f95eac88f8b6` | 2 | 02-web | `field_options` | 3 | 2 | 4 | **no** | — | `apps\web\src\pages\program-element\ProgramElementDataIssueModal.tsx` |
| `44e1d62e2176` | 1 | 02-web | `filtercount()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `ceaf6b1a3d18` | 2 | 08-platform | `fixturefile` | 2 | 4 | 4 | **no** | — | `scripts\run-engagement-phase0-local.mjs` |
| `d3467d14141b` | 1 | 02-web | `fmtqty()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\SecondaryDistributionPanel.tsx` |
| `dacd158c29a1` | 1 | 02-web | `formatdate()` | 2 | 4 | 4 | yes | — | `apps\web\src\components\PendingMemoryReviewPanel.tsx` |
| `b094d7f9b260` | 1 | 01-api | `gensection` | 2 | 4 | 4 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `3da8ba834d90` | CleanUp3 | 02-web | `get` | 3 | 2 | 4 | **no** | — | `apps\web\src\pages\clients\use-client-facilities.test.tsx` |
| `34111ecbd699` | 1 | 02-web | `getrawstring()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `e90829f3df40` | 1 | 01-api | `git()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\verify-pe-phase-10.ts` |
| `4090cb1ba7b7` | 1 | 02-web | `handleclose()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\clients\BulkImportClientsModal.tsx` |
| `e598b5d3d552` | 1 | 01-api | `hasmanualassociationsignal()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `c9d16b9fddca` | 1 | 02-web | `humanizetoken()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusDrawer.tsx` |
| `80cbeb6a9cfa` | 1 | 02-web | `inspectortarget` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\v2\PeV2SourceInspector.tsx` |
| `004732ee11f4` | 1 | 06-intel | `integer()` | 2 | 4 | 4 | yes | — | `apps\intel-api\src\hearing\intelligence\run-hearing-intelligence.ts` |
| `2e3c188fd89c` | 1 | 02-web | `integrationformvalues` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `8430cba8adda` | 1 | 01-api | `ismessagegoneerror()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `ca976b7bb697` | 1 | 02-web | `issue_types` | 3 | 2 | 4 | yes | — | `apps\web\src\pages\program-element\ProgramElementDataIssueModal.tsx` |
| `68c95d18a8a8` | 1 | 02-web | `latesteventdate()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `de243bc03773` | 1 | 02-web | `linkedbill` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `c50e72fac9d4` | CleanUp3 | 02-web | `locationprobe()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\engagement\EngagementApiPreviewIndicator.test.tsx` |
| `8f8e4a08b82a` | CleanUp3 | 02-web | `locationprobe()` | 2 | 4 | 4 | **no** | — | `apps\web\src\pages\clients\tracker\DistrictBriefComposerDrawer.held.test.tsx` |
| `dda6181f21a7` | 1 | 02-web | `m()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\WhatChangedPanel.tsx` |
| `2667775e22ce` | 1 | 01-api | `main()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\generate-actions.ts` |
| `905392efe262` | CleanUp3 | 01-api | `makeservice()` | 2 | 4 | 4 | yes | — | `apps\api\src\program-element\program-element-read-opportunities.spec.ts` |
| `a3cf6e72277f` | CleanUp3 | 01-api | `maketable()` | 3 | 2 | 4 | yes | **yes** | `apps\api\src\defense-budget\parser-router\rdte-durable-semantic-artifact-factory-v1.spec.ts` |
| `5dd87790c9d0` | CleanUp3 | 01-api | `manifest()` | 3 | 2 | 4 | yes | **yes** | `apps\api\scripts\validate-defense-budget-cycle-manifest.spec.ts` |
| `cc039755fac5` | 1 | 02-web | `membername()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\reviews\ReviewCard.tsx` |
| `f375dd696e0d` | CleanUp3 | 02-web | `members` | 5 | 1 | 4 | **no** | — | `apps\web\src\vnext\pages\business-development\bizdev-discover-filters.test.tsx` |
| `11af30bd0006` | 1 | 01-api | `memoryreviewidentity` | 2 | 4 | 4 | yes | — | `apps\api\src\memory\memory-review-inbox.service.ts` |
| `1b453e06d794` | 1 | 01-api | `metaboolean()` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `682a73c5e013` | 1 | 01-api | `metastring()` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `cee6f3c93721` | CleanUp3 | 02-web | `nodes` | 3 | 2 | 4 | **no** | — | `apps\web\src\vnext\pages\strategies\StrategyEditorVNext.dirty-guard.test.tsx` |
| `939ca8248b72` | 1 | 01-api | `nonblankstring` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\contracts\budget-cycle-manifest-v1.ts` |
| `0d069746504b` | 1 | 01-api | `normalizeemail()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `1311e8d8d9b3` | 1 | 01-api | `normalizeemail()` | 2 | 4 | 4 | yes | — | `apps\api\src\capabilities\targets\outreach-target-reference.service.ts` |
| `da02d17a378c` | CleanUp3 | 01-api | `nosleep()` | 5 | 1 | 4 | yes | — | `apps\api\scripts\enrich-assistance-award-details.spec.ts` |
| `7c70e9792577` | 1 | 08-platform | `ok()` | 2 | 4 | 4 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `6db1c23cad46` | CleanUp3 | 02-web | `openmerimock` | 2 | 4 | 4 | **no** | — | `apps\web\src\vnext\pages\client-crm\ClientCrmPage.header.test.tsx` |
| `6c63663bb663` | 1 | 02-web | `option()` | 5 | 1 | 4 | yes | — | `apps\web\src\vnext\pages\legiwatch\bills\FolderBillsTab.tsx` |
| `c98a540bd8a5` | 1 | 02-web | `pagelabel()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProofPackPanel.tsx` |
| `66ddefe9125a` | 1 | 01-api | `parsedargs` | 2 | 4 | 4 | yes | — | `apps\api\scripts\match-contractor-identifiers.ts` |
| `e0fc955e1469` | 1 | 01-api | `parsefile()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\engagement-phase0-dependency-manifest.ts` |
| `9d253915a0a0` | CleanUp3 | 02-web | `patchmock` | 2 | 4 | 4 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\AdvocacyMattersTab.test.tsx` |
| `136c8669d2ab` | CleanUp3 | 01-api | `pd()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.spec.ts` |
| `f52d237a41d3` | 1 | 02-web | `positionedevent` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `da92a3661c60` | 1 | 02-web | `projectsourcehref()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProjectsPanel.tsx` |
| `44f10958e5fd` | 1 | 02-web | `provisionhref()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `68c98bc595dd` | 1 | 01-api | `queryclient` | 2 | 4 | 4 | yes | — | `apps\api\scripts\snapshot-defense-budget-package0-v1.ts` |
| `db4f2fbcec6e` | 1 | 02-web | `ratiotorequest()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\program-element\MarkupMonitorPage.tsx` |
| `1372b5b4e834` | 1 | 01-api | `refuse()` | 2 | 4 | 4 | yes | — | `apps\api\scripts\accept-defense-budget-ingestion-review-v1.ts` |
| `efff9631a940` | 1 | 02-web | `rejectedcount()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `38501c090bff` | CleanUp3 | 02-web | `rejectgenerate()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `a808cb11c9cc` | 1 | 08-platform | `releasesha` | 2 | 4 | 4 | yes | — | `infra\cdk\bin\meriv2-operations.ts` |
| `9e71cc513137` | CleanUp3 | 02-web | `renderwithproviders()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\directory\StaffDirectoryProfilePage.test.tsx` |
| `bf9d43777176` | 2 | 01-api | `requiretestmodule` | 3 | 2 | 4 | **no** | — | `apps\api\test\community-funding-corpus-pglite.ts` |
| `299986862945` | CleanUp3 | 02-web | `resolvesave()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `6ece7ef041c9` | CleanUp3 | 08-platform | `resourcestringsof()` | 2 | 4 | 4 | yes | — | `infra\cdk\test\defense-budget-operations-stack.spec.ts` |
| `47bf98326cbb` | CleanUp3 | 01-api | `restoreenv()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\generation\evidence-source.service.spec.ts` |
| `cc6b8de58006` | CleanUp3 | 02-web | `selectversion()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `d1da8bb88b65` | CleanUp3 | 01-api | `sha` | 2 | 4 | 4 | **no** | **yes** | `apps\api\src\defense-budget\rdte\r1\r1-extractor-v1.spec.ts` |
| `7942e4a94a44` | 1 | 01-api | `sourcepath()` | 2 | 4 | 4 | yes | **yes** | `apps\api\src\defense-budget\stages\authorization\hasc-composer-v1.ts` |
| `5251cb91f717` | CleanUp3 | 02-web | `stablegettoken` | 3 | 2 | 4 | yes | — | `apps\web\src\components\chat\useMeriChatController.prospect-launch.test.tsx` |
| `8e882b479c5f` | CleanUp3 | 02-web | `stableimpersonation` | 5 | 1 | 4 | yes | — | `apps\web\src\components\chat\useMeriChatController.feedback-identity.test.tsx` |
| `9dc8b9311bca` | 1 | 02-web | `startedit()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\actions\ArtifactsPanel.tsx` |
| `cfd0786eaa2e` | 1 | 01-api | `stringfield()` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\governed-meeting-ai.factory.ts` |
| `699c9542b3d0` | 1 | 02-web | `sumornull()` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictFederalMarketPanel.tsx` |
| `f33e7b5d8bb4` | 1 | 01-api | `tabledigest` | 2 | 4 | 4 | yes | — | `apps\api\scripts\engagement-phase1-read-parity.ts` |
| `d540f5d73057` | CleanUp3 | 01-api | `tenantbid` | 3 | 2 | 4 | yes | — | `apps\api\src\business-development\bizdev-brief.service.spec.ts` |
| `b100faaaa5f5` | 1 | 02-web | `tenantlistrow` | 2 | 4 | 4 | yes | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.tsx` |
| `19b8b89e5bfa` | 1 | 01-api | `tenants` | 2 | 4 | 4 | yes | — | `apps\api\src\engagement\synthetic-document-deletion.helpers.ts` |
| `d115da4c5acc` | CleanUp3 | 02-web | `usememock` | 3 | 2 | 4 | **no** | — | `apps\web\src\vnext\app\VNextRouter.engagement-gate.test.tsx` |
| `0f2a5037e6c5` | 1 | 01-api | `withclaimanchors()` | 2 | 4 | 4 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `929d5ad0c068` | CleanUp3 | 02-web | `{ apigetmock }` | 5 | 1 | 4 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictFederalMarketPanel.test.tsx` |
| `f612595f34e2` | CleanUp3 | 01-api | `.$executerawunsafe()` | 2 | 3 | 3 | **no** | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-read-repository-prisma-v1.spec.ts` |
| `747ee95d85c4` | 2 | 01-api | `.batchsize()` | 2 | 3 | 3 | **no** | — | `apps\api\src\knowledge\episodes\knowledge-episode-worker-config.service.ts` |
| `ca1fa5587a5c` | 2 | 07-workspace-onboard | `.check()` | 2 | 3 | 3 | **no** | — | `apps\onboard-api\src\health\health.controller.ts` |
| `7abeb701099c` | 1 | 01-api | `.configured()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meriv2-chat.client.ts` |
| `9a5374320bde` | 1 | 07-workspace-onboard | `.configured()` | 2 | 3 | 3 | yes | — | `apps\workspace\src\meriv2\meriv2-orchestrator.client.ts` |
| `e6a788d8f88f` | CleanUp3 | 01-api | `.countopenblockingconflicts()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `90cc4928c20c` | CleanUp3 | 01-api | `.countunsupportedprojections()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `481c89e511f0` | 1 | 07-workspace-onboard | `.csnotifyemail()` | 2 | 3 | 3 | yes | — | `apps\onboard-api\src\funnel\funnel.service.ts` |
| `df9d8ec73162` | 1 | 01-api | `.disconnect()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\google\google-integration-actions.controller.ts` |
| `7b9553188529` | 1 | 03-defense | `.embeddingmodel()` | 2 | 3 | 3 | yes | — | `apps\defense-api\src\program-elements\budget-lines-read.service.ts` |
| `48ed9cc9561a` | 1 | 04-meri | `.execute()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\repair\orchestrator-tool-executor.ts` |
| `b8952e6f2564` | CleanUp3 | 01-api | `.findterminalrunbyidentity()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\services\budget-verification-v1.service.cycle-identity.spec.ts` |
| `1de912ef79c8` | 1 | 02-web | `.getderivedstatefromerror()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\client-crm\VNextClientCrmRoute.tsx` |
| `a7896ca3c1f4` | CleanUp3 | 01-api | `.getobject()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\ingestion-outbox-drain-real-readiness-integration.spec.ts` |
| `1a9aef488454` | 1 | 01-api | `.getsuccessredirect()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\google\google-oauth.service.ts` |
| `4daa3d96b150` | 1 | 01-api | `.hasroottransaction()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\procurement\procurement-line-writer.service.ts` |
| `028760918b19` | 1 | 01-api | `.invalidate()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meri-feature-flags.service.ts` |
| `9abda326cfc4` | 1 | 06-intel | `.isopen()` | 2 | 3 | 3 | yes | — | `apps\intel-api\src\hearing\capture\server-deepgram-stream.manager.ts` |
| `3c4a8fc71a7c` | 1 | 01-api | `.isratelimited()` | 2 | 3 | 3 | yes | — | `apps\api\src\external\tango\tango-dibbs.client.ts` |
| `8113591d5575` | 1 | 06-intel | `.list()` | 2 | 3 | 3 | yes | — | `apps\intel-api\src\tracker\calendar\agenda-rule.controller.ts` |
| `add48493552d` | CleanUp3 | 01-api | `.load()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\governed-acceptance\candidate-correction\phase10b35c-candidate-correction-e2e.integration.spec.ts` |
| `f83f69da6298` | CleanUp3 | 01-api | `.loadactivesnapshot()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `283e999f9a67` | CleanUp3 | 01-api | `.loadcandidates()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `513cc1a2db4d` | CleanUp3 | 01-api | `.loadcyclecertifications()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `0d1fc41e993e` | CleanUp3 | 01-api | `.loadforscope()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `f58274adfee6` | CleanUp3 | 01-api | `.loadlatestterminalrunid()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `54b93b8f4bfb` | CleanUp3 | 01-api | `.loadprojectionplans()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-eligibility-service-v1.spec.ts` |
| `e5f0b79df673` | CleanUp3 | 01-api | `.loadprojections()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-service-v1.spec.ts` |
| `ac513c025383` | CleanUp3 | 01-api | `.loadverifiedartifact()` | 2 | 3 | 3 | **no** | **yes** | `apps\api\src\defense-budget\promotion\readiness\family-certification-materialization-v1.spec.ts` |
| `3b66275a3935` | 2 | 01-api | `.maxattempts()` | 2 | 3 | 3 | **no** | — | `apps\api\src\knowledge\episodes\knowledge-episode-worker-config.service.ts` |
| `2dbe4ef536b2` | 1 | 07-workspace-onboard | `.onmoduledestroy()` | 2 | 3 | 3 | yes | — | `apps\onboard-api\src\prisma\prisma.service.ts` |
| `8b19e0909c42` | 1 | 07-workspace-onboard | `.overagepriceid()` | 2 | 3 | 3 | yes | — | `apps\onboard-api\src\billing\billing.service.ts` |
| `75f1eaaa01cd` | 1 | 01-api | `.overview()` | 2 | 3 | 3 | yes | — | `apps\api\src\federal-spending\federal-spending.controller.ts` |
| `ec3ba6b3b0de` | CleanUp3 | 01-api | `.readcandidate()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `9491ae356809` | CleanUp3 | 01-api | `.readchecks()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `151b19a2ee94` | CleanUp3 | 01-api | `.readdiscrepancies()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `9d4a3796ae32` | CleanUp3 | 01-api | `.readproofsnapshots()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `e6ec49cd358c` | CleanUp3 | 01-api | `.readreviewdecisions()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `2eef95e64162` | CleanUp3 | 01-api | `.readrun()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\negative-controls.spec.ts` |
| `0a887180630b` | 1 | 01-api | `.safeerror()` | 2 | 3 | 3 | yes | — | `apps\api\src\clients\client-advocacy-matter.service.ts` |
| `56e1ad7e34e4` | 1 | 01-api | `.start()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\google\google-oauth.controller.ts` |
| `3aec8e0612a2` | 3 | 03-defense | `.test_engine_name()` | 2 | 3 | 3 | **no** | — | `apps\defense-budget-parser\tests\test_camelot_engine.py` |
| `52509ef248b1` | 1 | 01-api | `.upcomingdeadlines()` | 2 | 3 | 3 | yes | — | `apps\api\src\federal-register\federal-register.controller.ts` |
| `e3f377a84611` | CleanUp3 | 08-platform | `actionsof()` | 2 | 3 | 3 | yes | — | `infra\cdk\test\defense-budget-operations-stack.spec.ts` |
| `b5c97b9e6d20` | 1 | 08-platform | `adminsql()` | 2 | 3 | 3 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `22a6b6600603` | CleanUp3 | 02-web | `apigetmock` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\intelligence\HearingWatchPage.archive.test.tsx` |
| `c15cd08fdb51` | CleanUp3 | 02-web | `apipost` | 4 | 1 | 3 | yes | — | `apps\web\src\vnext\pages\legiwatch\lib\wave1-notifications.test.ts` |
| `9e3ff3e91ae0` | CleanUp3 | 02-web | `apipost` | 4 | 1 | 3 | yes | — | `apps\web\src\vnext\pages\legiwatch\feed\feed-triage-feedback.integration.test.tsx` |
| `1b439fe82cc9` | 1 | 01-api | `aserror()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\lib\congress-actions.ts` |
| `4be41bf9b857` | 1 | 01-api | `asiso()` | 2 | 3 | 3 | yes | — | `apps\api\src\research-portfolios\research-portfolio-review.service.ts` |
| `f8932167958e` | 1 | 01-api | `assert()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\outreach-v3-phase2-delete-protection-rehearsal.ts` |
| `197c79465b63` | 2 | 01-api | `assert()` | 2 | 3 | 3 | **no** | — | `apps\api\scripts\qualify-package5-program-acquisition.ts` |
| `49072cf7bcd9` | 1 | 08-platform | `assert()` | 2 | 3 | 3 | yes | — | `scripts\verify-outreach-v3-phase4-6-combined.mjs` |
| `9cbf5443f6b1` | 2 | 01-api | `assertnever()` | 2 | 3 | 3 | **no** | — | `apps\api\src\live-hearings\phase9\legiwatch-phase9-jobs.service.ts` |
| `255ea434c3ad` | 1 | 01-api | `asstring()` | 2 | 3 | 3 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-approval.service.ts` |
| `f57551877181` | 1 | 01-api | `asstring()` | 2 | 3 | 3 | yes | — | `apps\api\src\clients\advocacy-history-hierarchy.interceptor.ts` |
| `0b9b08bdf6d2` | 1 | 02-web | `astab()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `75eb14d73b6e` | 1 | 01-api | `blocked()` | 2 | 3 | 3 | yes | — | `apps\api\src\outreach-v3\drafts\outreach-v3-draft-approval.service.ts` |
| `51402f27d9bf` | CleanUp3 | 02-web | `bylabel()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.capabilities.test.tsx` |
| `1e39adb36fc5` | CleanUp3 | 02-web | `candidatesearch()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\business-development\bizdev-discover-filters.test.tsx` |
| `407cf92210d5` | 1 | 01-api | `canonicaljson()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\lib\memory-governance-backfill.ts` |
| `0739860de12f` | 1 | 01-api | `canonicaljson()` | 2 | 3 | 3 | yes | — | `apps\api\src\funding-execution\funding-execution.store.ts` |
| `527d6c979e9d` | 1 | 01-api | `cell` | 4 | 1 | 3 | yes | **yes** | `apps\api\src\defense-budget\rdte\cycle\rdte-golden-cycle-v1.ts` |
| `5dfb968255d9` | 1 | 02-web | `centeravailability` | 2 | 3 | 3 | yes | — | `apps\web\src\components\MemoryGovernanceCenterHost.tsx` |
| `2e4e85940a31` | 1 | 02-web | `clerkprovider()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\testing\visual\auth-fixture.tsx` |
| `3c7a003fff36` | CleanUp3 | 04-meri | `clientrepo` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-assistant.service.spec.ts` |
| `0bfc858a9ee9` | 1 | 02-web | `committeelabel()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\ProvisionsPanel.tsx` |
| `eae3277ded05` | 1 | 04-meri | `compactarray()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\retrieval\meri-retrieval-result.ts` |
| `6c7c4eb8912e` | 1 | 02-web | `compactdate()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `b4599f9b0812` | 2 | 02-web | `confbadge()` | 2 | 3 | 3 | **no** | — | `apps\web\src\pages\program-element\BudgetLinePanels.tsx` |
| `d492c1453358` | CleanUp3 | 01-api | `ctx` | 4 | 1 | 3 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo-citations.spec.ts` |
| `ae34a8197f85` | CleanUp3 | 01-api | `ctx` | 4 | 1 | 3 | yes | — | `apps\api\src\meri\meri-procedure-runtime-validation.service.spec.ts` |
| `d195800bbe59` | CleanUp3 | 01-api | `ctxfor()` | 2 | 3 | 3 | **no** | — | `apps\api\src\learning\adapters\crm-fill-finding.adapter.spec.ts` |
| `0f4ea2893d55` | 1 | 04-meri | `datems()` | 2 | 3 | 3 | yes | — | `packages\meriv2-core\src\context\compiler.ts` |
| `199dc3a7639e` | 1 | 01-api | `dateonly()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\federal-award-date-impact-report.ts` |
| `b12048642826` | CleanUp3 | 01-api | `daysago()` | 2 | 3 | 3 | yes | — | `apps\api\src\intelligence\coverage\coverage-gap.service.spec.ts` |
| `76dbf48a09dd` | CleanUp3 | 01-api | `delegate()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\parser-router\parser-run-identity-v1.spec.ts` |
| `91ef2d491a55` | 2 | 01-api | `deny()` | 2 | 3 | 3 | **no** | — | `apps\api\src\engagement\synthetic-document-deletion.helpers.ts` |
| `8f25939ebc34` | 1 | 02-web | `dircontactsresponse` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\workspace\ContextBuilderPage.tsx` |
| `c908c56b32c4` | CleanUp3 | 01-api | `eligibility()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\promotion\eligibility-bound-projection-source-prisma-v1.spec.ts` |
| `a524a25f5e3c` | 1 | 01-api | `emptystats()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `641a2b7fe469` | 2 | 01-api | `encodecursor()` | 2 | 3 | 3 | **no** | — | `apps\api\src\program-element\acquisition-continuity\acquisition-continuity-read.service.ts` |
| `fcc1a33d5556` | CleanUp3 | 04-meri | `entry()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\repair\live-repair.service.spec.ts` |
| `787f025f7bd7` | 1 | 02-web | `entrykey()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\actions\CoveragePanel.tsx` |
| `5565c81dd25b` | 1 | 01-api | `escaperegex()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\lib\memory-phase2-persistence-contract.ts` |
| `b6295abda92c` | 1 | 04-meri | `escaperegex()` | 2 | 3 | 3 | yes | — | `packages\meriv2-core\src\assurance\exact-comparison.ts` |
| `a61e3d6ff495` | 1 | 01-api | `escaperegexp()` | 2 | 3 | 3 | yes | — | `apps\api\src\knowledge\mailbox\mailbox-knowledge-worker.contract.spec.ts` |
| `6706d278d4a4` | 1 | 02-web | `escaperegexp()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\engagement\EngagementPage.tsx` |
| `5dc44ca879b4` | 2 | 08-platform | `evidence` | 4 | 1 | 3 | **no** | — | `scripts\run-engagement-phase1-local.mjs` |
| `fed6c426aa06` | 2 | 08-platform | `evidencedir` | 4 | 1 | 3 | **no** | — | `scripts\deploy-meriv2-operations-dark.mjs` |
| `2fa1c04b44f2` | 1 | 02-web | `externalurl()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\clients\ClientProfilePage.tsx` |
| `32b89d49694b` | 1 | 01-api | `fail()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\ops\rehearse-bizdev-discover-filters.ts` |
| `8bd9c318f315` | 1 | 04-meri | `fail()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\steward\context-compare-prompt.ts` |
| `b4412c9727a1` | 1 | 08-platform | `fail()` | 2 | 3 | 3 | yes | — | `scripts\verify-outreach-v3-phase2-db.mjs` |
| `6650326d7a3d` | CleanUp3 | 01-api | `fetchmock()` | 2 | 3 | 3 | yes | — | `apps\api\src\external\tango\tango-sbir.client.spec.ts` |
| `23030c39cf70` | 1 | 01-api | `fingerprint()` | 2 | 3 | 3 | yes | — | `apps\api\src\program-element\acquisition-continuity\acquisition-continuity-read.service.ts` |
| `7f7c847a10aa` | 1 | 01-api | `finitedate()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meri-research-debrief-proof.ts` |
| `cb6e7ffd24bf` | 1 | 02-web | `fmtm()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\FundingNarrativePanel.tsx` |
| `e4b86401616d` | 1 | 02-web | `freshnesspill()` | 2 | 3 | 3 | yes | — | `apps\web\src\components\dossier\SourceLink.tsx` |
| `3cd1e8ce7189` | 1 | 02-web | `handlekeydown()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\engagement\VNextMeetingLibrary.tsx` |
| `309ed5fbfdc8` | 1 | 02-web | `icon()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\funding-opportunities\FundingOpportunityV2Detail.tsx` |
| `41508a7e1ec3` | CleanUp3 | 01-api | `identity` | 4 | 1 | 3 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\hacd\hacd-verification-wiring.spec.ts` |
| `8b25fdf12ebf` | 1 | 01-api | `inventory` | 2 | 3 | 3 | yes | — | `apps\api\scripts\engagement-phase3-full-read-parity.ts` |
| `49183b842e8a` | 1 | 02-web | `isblanketauthorizer()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `051097807f90` | 1 | 02-web | `isinternalhref()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\clients\intelligence-v1\components\BriefingCard.tsx` |
| `aabb9937d3f9` | 1 | 01-api | `iso()` | 2 | 3 | 3 | yes | — | `apps\api\src\federal-spending\federal-market.service.ts` |
| `d714947d409d` | 1 | 01-api | `iso()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\governed-ingestion-manifest\ingestion-manifest-repository-v1.ts` |
| `8f2e648f42ec` | 1 | 01-api | `isoday()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\sync-tango-dibbs.ts` |
| `f6f370a64ab1` | 1 | 03-defense | `isplainobject()` | 2 | 3 | 3 | yes | — | `apps\defense-parser-orchestrator\src\provider-decision.mjs` |
| `6d7021be0749` | 1 | 01-api | `isrecord()` | 2 | 3 | 3 | yes | — | `apps\api\src\knowledge\mailbox\mailbox-knowledge-extractor.service.ts` |
| `002b45526047` | 1 | 01-api | `isrecord()` | 2 | 3 | 3 | yes | — | `apps\api\src\clients\advocacy-history-hierarchy.interceptor.ts` |
| `35cc536266df` | 1 | 01-api | `isrecord()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\generation\outreach-context-plane.service.ts` |
| `8820042734ce` | 1 | 02-web | `isrecord()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\strategy\agents\agent-utils.ts` |
| `37d02384a542` | 1 | 01-api | `isueishaped()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\generate-grant-opportunity-candidates.ts` |
| `2f28619d746a` | 1 | 01-api | `jsonobject()` | 2 | 3 | 3 | yes | — | `apps\api\src\retrieval\adapters\core-prisma-retrieval.adapter.ts` |
| `88277e24baf7` | 1 | 08-platform | `kebab()` | 2 | 3 | 3 | yes | — | `infra\cdk\lib\constructs\scheduled-ingestion-jobs.ts` |
| `2edd751bea5b` | 1 | 02-web | `last()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\PdocDetailPanel.tsx` |
| `04f24a4bdaac` | 1 | 01-api | `list()` | 2 | 3 | 3 | yes | — | `apps\api\src\funding-opportunities\funding-opportunity-v2-detail.service.ts` |
| `cc4c40526c85` | 1 | 01-api | `log()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\ops\rehearse-bizdev-discover-filters.ts` |
| `f6af3dd66039` | 1 | 02-web | `logourl()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\settings\McpServersCard.tsx` |
| `dd5d4c733bd2` | CleanUp3 | 04-meri | `mericontext` | 4 | 1 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meriv3-external-company-research-v3.spec.ts` |
| `13581dfa70c4` | CleanUp3 | 02-web | `message()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\meri\VNextMeriWorkspace.research-portfolio-starter.test.tsx` |
| `ada417c19db5` | 1 | 01-api | `metadataof()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `63e337eab61b` | 1 | 01-api | `nonnegativeinteger()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meri-research-debrief-proof.ts` |
| `412ea68db7fc` | 1 | 01-api | `normalizestatus()` | 2 | 3 | 3 | yes | — | `apps\api\src\memory\memory-conflict.service.ts` |
| `6de354ab32fc` | 1 | 01-api | `normalizewhitespace()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\sync-dod-orgcharts.ts` |
| `63b09cd28b9e` | 1 | 02-web | `noticetypecolor()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\ProcurementActivityPanel.tsx` |
| `075f5e4cbdb1` | 1 | 01-api | `num()` | 2 | 3 | 3 | yes | **yes** | `apps\api\scripts\lib\phase10b35-artifact-summary.ts` |
| `7fd6255ebfd3` | 1 | 01-api | `numberornull()` | 2 | 3 | 3 | yes | — | `apps\api\src\intelligence\x-feed\x-feed.service.ts` |
| `f5ef6b39fd79` | CleanUp3 | 02-web | `openbell()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\shell\TopBar\NotificationBell.bizdev.test.tsx` |
| `f206bdaf9a1a` | 1 | 04-meri | `orderedunique()` | 2 | 3 | 3 | yes | — | `packages\meriv2-core\src\grounding\claim-inventory.ts` |
| `371aaca8e1b4` | 1 | 01-api | `packetrecord()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\generation\outreach-context-plane.service.ts` |
| `47921de1fb15` | 1 | 01-api | `parsejobclient` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\parse-runner.ts` |
| `9bf4aaa3d9a5` | 1 | 02-web | `passagepct()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\client-crm\tabs\BillUpdatesDrawer.tsx` |
| `56b41bf0742c` | 1 | 01-api | `positiveinteger()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meri-research-child-task.ts` |
| `d112f68f8363` | 1 | 01-api | `pushcandidate()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-projection-planner-v1.ts` |
| `427039c9128e` | 1 | 01-api | `ratio()` | 2 | 3 | 3 | yes | — | `apps\api\src\knowledge\entities\entity-resolution-evaluator.ts` |
| `bc2392e75349` | 1 | 01-api | `read()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\lint-pe-scripts.ts` |
| `9d5e34e120a5` | 1 | 08-platform | `read()` | 2 | 3 | 3 | yes | — | `scripts\verify-outreach-v3-p1-architecture.mjs` |
| `50490323c0ac` | 1 | 02-web | `readcodes()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `6d1559c5d02c` | CleanUp3 | 01-api | `readfixture()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\engagement-route-manifest.spec.ts` |
| `aee322c28533` | 1 | 02-web | `readtab()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `fd81d5775781` | 1 | 01-api | `rec()` | 2 | 3 | 3 | yes | — | `apps\api\src\vendor-reference\vendor-reference-sam.client.ts` |
| `5fcd57686ce1` | 1 | 01-api | `record()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\ingest-florida-legislative-directories.ts` |
| `54f7bd860732` | 1 | 02-web | `record()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\meri\MeriWordArtifactPreview.tsx` |
| `7d734819de81` | 1 | 01-api | `requireuuid()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\governed-ingestion-manifest\ingestion-manifest-repository-v1.ts` |
| `ef6a368e4a91` | 1 | 01-api | `round2()` | 2 | 3 | 3 | yes | — | `apps\api\src\program-element\budget-position.ts` |
| `241721a42f67` | 1 | 02-web | `routeloading()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\directory\VNextDirectoryRoutes.tsx` |
| `df7f507f7a07` | 1 | 02-web | `rowmovement()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\v2\PeV2Explore.tsx` |
| `bee2b4bf16f9` | 1 | 03-defense | `rows()` | 2 | 3 | 3 | yes | — | `apps\defense-api\src\budget-lifecycle-product\prisma-budget-lifecycle-read.store.ts` |
| `98073492f57a` | CleanUp3 | 02-web | `setsearchparamsmock` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\intelligence\district-nexus\DistrictNexusPage.test.tsx` |
| `a38520f2606e` | CleanUp3 | 02-web | `seturl()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\reviews\ReviewQueuePage.test.tsx` |
| `dca04f9d48c0` | 1 | 01-api | `sha256()` | 2 | 3 | 3 | yes | — | `apps\api\src\directory\legistorm\directory-snapshot-publisher.spec.ts` |
| `9eabdbe5458e` | 1 | 01-api | `sha256()` | 2 | 3 | 3 | yes | — | `apps\api\src\funding-execution\funding-execution.store.ts` |
| `74974d654ed4` | 1 | 04-meri | `sha256()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\repair\live-repair.service.ts` |
| `f93b63dc7181` | 1 | 01-api | `sha256hex()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\contracts\canonical-json.ts` |
| `6cafff2d3e6e` | 1 | 01-api | `sha256hex()` | 2 | 3 | 3 | yes | **yes** | `apps\api\scripts\phase10b31-replay-recovered-artifact.ts` |
| `7ccba8b7e355` | 1 | 01-api | `sha256ofbuffer()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\raw-archive.service.ts` |
| `6da9379ad3ad` | 1 | 01-api | `sha256offile()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\raw-archive.service.ts` |
| `03167d6ca408` | 1 | 02-web | `shortgreetingname()` | 2 | 3 | 3 | yes | — | `apps\web\src\components\chat\MeriWorkspaceWindow.tsx` |
| `abf26eb74c2d` | 1 | 01-api | `sigmoid()` | 2 | 3 | 3 | yes | — | `apps\api\src\intelligence\passage-probability.model.ts` |
| `ce09fa7c4bdb` | 1 | 02-web | `signed()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\FundingNarrativePanel.tsx` |
| `8169fb6f399b` | 1 | 07-workspace-onboard | `sleep()` | 2 | 3 | 3 | yes | — | `apps\workspace\src\hillday\hillday-generation.service.ts` |
| `b8b298d76c1d` | 1 | 01-api | `sorteduniquepages()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\non-rdte-proof-bound-artifact-v1.ts` |
| `acfa8e704450` | CleanUp3 | 02-web | `source()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\figma-strategy-legiwatch-contract.test.ts` |
| `49450470e45e` | 1 | 02-web | `sourcefor()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `80334de52d82` | 1 | 02-web | `sourcelabel()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalMarketDetailDrawer.tsx` |
| `f8c107ce7a97` | CleanUp3 | 02-web | `stableapi` | 4 | 1 | 3 | yes | — | `apps\web\src\components\chat\useMeriChatController.feedback.phase4.test.tsx` |
| `20c39ec404c7` | CleanUp3 | 02-web | `stableauth` | 4 | 1 | 3 | yes | — | `apps\web\src\components\chat\useMeriChatController.feedback-identity.test.tsx` |
| `b699f08041fd` | 1 | 01-api | `stablestringify()` | 2 | 3 | 3 | yes | — | `apps\api\src\knowledge\entities\entity-identity-governance.service.ts` |
| `2dca4efb225d` | 1 | 05-strategy | `stablestringify()` | 2 | 3 | 3 | yes | — | `apps\api-strategy\src\agents\execution-assurance.spec.ts` |
| `b2e5e7286b1a` | 1 | 01-api | `startofday()` | 2 | 3 | 3 | yes | — | `apps\api\src\hearing-discovery\coverage-audit.service.ts` |
| `5fa41dcbf94d` | 1 | 01-api | `startofutcday()` | 2 | 3 | 3 | yes | — | `apps\api\src\funding-opportunities\source-lifecycle.ts` |
| `162927a5056b` | 1 | 02-web | `statuslabel()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.tsx` |
| `8900c3229427` | CleanUp3 | 05-strategy | `store` | 2 | 3 | 3 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `b9a47df22744` | 1 | 01-api | `stringarg()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\backfill-canonical-entities.ts` |
| `1acd40a714d4` | 1 | 01-api | `stringornull()` | 2 | 3 | 3 | yes | — | `apps\api\src\context\internal-strategy-context.controller.ts` |
| `a417573497f0` | 1 | 01-api | `stringtags()` | 2 | 3 | 3 | yes | — | `apps\api\src\district-nexus\grant-opportunity-candidates.ts` |
| `d1d60ece30a9` | 1 | 01-api | `stringvalue()` | 2 | 3 | 3 | yes | — | `apps\api\src\clients\client-profile-fill-context-plane.service.ts` |
| `2d6306fae848` | 1 | 04-meri | `stringvalue()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\retrieval\meri-external-entity-resolution.ts` |
| `2fc4458c655c` | 1 | 08-platform | `stripcomments()` | 2 | 3 | 3 | yes | — | `scripts\check-context-plane-new-bypasses.mjs` |
| `a2bf0e7a7e5e` | CleanUp3 | 01-api | `stubmatterexists()` | 2 | 3 | 3 | yes | — | `apps\api\src\clients\client-advocacy-matter-direct-evidence.service.spec.ts` |
| `410b5ffa2b5f` | CleanUp3 | 01-api | `target()` | 2 | 3 | 3 | yes | — | `apps\api\src\outreach-v3\generation\outreach-v3-generation-plan.spec.ts` |
| `d2b42c78e9e3` | 1 | 01-api | `text()` | 2 | 3 | 3 | yes | — | `apps\api\src\funding-opportunities\funding-opportunity-v2-detail.service.ts` |
| `f488438096bb` | 1 | 01-api | `text()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\verify-meriv2-development-completeness.ts` |
| `f6c067d4e19e` | 1 | 02-web | `titlecase()` | 2 | 3 | 3 | yes | — | `apps\web\src\vnext\pages\directory\StateCommitteesVNext.tsx` |
| `d3a76598303f` | 1 | 01-api | `todatestringutc()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\sync-legistorm-directory.ts` |
| `fee025ebfbdd` | 1 | 01-api | `tojsoninput()` | 2 | 3 | 3 | yes | — | `apps\api\src\evaluation\evaluation-capture.service.ts` |
| `abf28c0e747f` | 1 | 04-meri | `toollabel()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat-prompt.ts` |
| `437fb0737fc3` | 1 | 02-web | `toolmanifestresponse` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\settings\SkillsPage.tsx` |
| `1d08a886bd5c` | 1 | 01-api | `tx` | 2 | 3 | 3 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `707b52a77732` | 1 | 01-api | `unique()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\client-association.service.ts` |
| `4419e6accd5f` | 1 | 01-api | `unique()` | 2 | 3 | 3 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `dc25653464b6` | 1 | 04-meri | `unique()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\meriv3\meri-semantic-tool-gateway.ts` |
| `baea2afdd727` | 1 | 04-meri | `unique()` | 2 | 3 | 3 | yes | — | `apps\meriv2-orchestrator\src\meri\retrieval\meri-retrieval-coverage.ts` |
| `e56d87585ac2` | CleanUp3 | 01-api | `updatecandidatestatus()` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\budget-verification-repository.spec.ts` |
| `64b441c5fee1` | 1 | 01-api | `usesdeprecateddryrunalias()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\lib\defense-budget-ingest-mode.ts` |
| `ce6eb8523852` | 1 | 01-api | `validtimestamp()` | 2 | 3 | 3 | yes | — | `apps\api\src\meri\meri-research-child-task.ts` |
| `19493e3b6c6f` | 1 | 01-api | `verificationclock` | 2 | 3 | 3 | yes | **yes** | `apps\api\src\defense-budget\verification\budget-verification-service.ts` |
| `67c1edbd3e52` | 1 | 01-api | `verificationfor()` | 2 | 3 | 3 | yes | — | `apps\api\src\intelligence\alert-memo\alert-memo.service.ts` |
| `f6ea9c8e1c95` | 1 | 01-api | `visible_client_filter` | 4 | 1 | 3 | yes | — | `apps\api\src\district-nexus\district-nexus-relationships.service.ts` |
| `fba3f2cc5b35` | CleanUp3 | 01-api | `whereof()` | 2 | 3 | 3 | yes | — | `apps\api\scripts\sync-tango-entities.spec.ts` |
| `94a5d777e888` | 1 | 02-web | `yearposition()` | 2 | 3 | 3 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `591271b91782` | 1 | 08-platform | `{ prismaclient }` | 4 | 1 | 3 | yes | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `28853f87e3d4` | 1 | 03-defense | `{ sourceadapterregistry }` | 4 | 1 | 3 | yes | — | `apps\defense-api\scripts\discover-expected-source.mjs` |
| `34cee32ca9de` | 1 | 01-api | `{ values: args }` | 2 | 3 | 3 | yes | — | `apps\api\scripts\prepopulate-all.ts` |
| `14c912bf6e93` | CleanUp3 | 01-api | `.insertauthorization()` | 2 | 2 | 2 | yes | **yes** | `apps\api\src\defense-budget\promotion\promotion-authorization-service-v1.spec.ts` |
| `43b1cb9e623c` | 3 | 03-defense | `.test_engine_version()` | 2 | 2 | 2 | **no** | — | `apps\defense-budget-parser\tests\test_camelot_engine.py` |
| `f249ea1f45fc` | CleanUp3 | 02-web | `api` | 3 | 1 | 2 | yes | — | `apps\web\src\vnext\pages\strategies\context\context-workflows.test.tsx` |
| `7133beeaa571` | CleanUp3 | 02-web | `apiget` | 3 | 1 | 2 | yes | — | `apps\web\src\vnext\pages\legiwatch\lib\wave1-notifications.test.ts` |
| `90c8fa8505b2` | CleanUp3 | 02-web | `apiput` | 3 | 1 | 2 | yes | — | `apps\web\src\vnext\pages\legiwatch\lib\wave1-notifications.test.ts` |
| `0102ea8bcf4d` | 2 | 08-platform | `changed` | 3 | 1 | 2 | **no** | — | `scripts\verify-outreach-v3-phase4-code.mjs` |
| `db577a560470` | CleanUp3 | 04-meri | `citations` | 2 | 2 | 2 | **no** | — | `packages\meriv2-core\src\grounding\claim-inventory-fixture.spec.ts` |
| `f437e15555b8` | CleanUp3 | 02-web | `clients` | 2 | 2 | 2 | **no** | — | `apps\web\src\pages\engagement\outreach\v2\StepGenerate.attachments.test.tsx` |
| `ef1ea709c4c9` | CleanUp3 | 02-web | `clients` | 2 | 2 | 2 | **no** | — | `apps\web\src\vnext\pages\legiwatch\settings\watchlist-management.integration.test.tsx` |
| `f84b9394c72a` | CleanUp3 | 02-web | `clients` | 2 | 2 | 2 | yes | — | `apps\web\src\vnext\pages\legiwatch\hearings\CreateBriefDialog.test.tsx` |
| `7ac9d738a99b` | CleanUp3 | 02-web | `clients` | 2 | 2 | 2 | yes | — | `apps\web\src\pages\intelligence\LiveHearingRoomPage.recap.test.tsx` |
| `91d025355de8` | CleanUp3 | 01-api | `command()` | 2 | 2 | 2 | yes | — | `apps\api\src\outreach-v3\state\outreach-campaign-state.spec.ts` |
| `5bc84f35b0f4` | CleanUp3 | 01-api | `committees` | 2 | 2 | 2 | yes | — | `apps\api\src\directory\directory-detail.spec.ts` |
| `f903c602aebd` | CleanUp3 | 01-api | `connection` | 3 | 1 | 2 | yes | — | `apps\api\src\engagement\google\google-sync.backfill-state.spec.ts` |
| `69b72993419e` | CleanUp3 | 01-api | `ctx` | 3 | 1 | 2 | yes | — | `apps\api\src\business-development\bizdev-brief.service.spec.ts` |
| `7d518d22e418` | CleanUp3 | 01-api | `day()` | 3 | 1 | 2 | yes | — | `apps\api\src\hearing-discovery\canonical-diff.spec.ts` |
| `3ac7a01c77f9` | 1 | 01-api | `documentfactassertionv1` | 3 | 1 | 2 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\conference\appropriations-conference-certifier-v1.ts` |
| `857fceb958a6` | 1 | 01-api | `eligibility()` | 2 | 2 | 2 | yes | **yes** | `apps\api\scripts\pe-budget-phase7-gap3-authorize-rehearsal.ts` |
| `71de581b56b3` | 1 | 01-api | `findmany()` | 2 | 2 | 2 | yes | — | `apps\api\scripts\backfill-assistance-awards-bulk.ts` |
| `759b7efbdc6a` | 1 | 03-defense | `flag()` | 3 | 1 | 2 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `fb08fd21a46d` | 1 | 08-platform | `forbidden_anywhere` | 2 | 2 | 2 | yes | — | `scripts\verify-phase8-session2.mjs` |
| `2a1eb9c26d4a` | CleanUp3 | 02-web | `getcontacttripsmock` | 2 | 2 | 2 | **no** | — | `apps\web\src\pages\directory\ContactTripsSection.test.tsx` |
| `835f278adf00` | CleanUp3 | 02-web | `getmock` | 2 | 2 | 2 | yes | — | `apps\web\src\vnext\pages\client-crm\ClientDataHealthDrawer.test.tsx` |
| `232ff3203719` | CleanUp3 | 04-meri | `human()` | 3 | 1 | 2 | yes | — | `packages\meriv2-core\src\context\compiler-v2.spec.ts` |
| `4ae86549d704` | CleanUp3 | 01-api | `lookupinput()` | 2 | 2 | 2 | yes | — | `apps\api\src\knowledge\entities\canonical-model-candidate-reconciliation.provider.spec.ts` |
| `1a44a2f7e977` | 1 | 01-api | `maplabelcolumns()` | 2 | 2 | 2 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\c1\c1-extractor-v1.ts` |
| `ef5270c90aee` | CleanUp3 | 02-web | `mocks` | 3 | 1 | 2 | yes | — | `apps\web\src\components\chat\AnalysisChartCard.test.tsx` |
| `852fc690dc87` | CleanUp3 | 03-defense | `mods()` | 2 | 2 | 2 | **no** | — | `apps\defense-api\src\budget-lifecycle\discovery\govinfo-resumability.spec.ts` |
| `4fb51a9808dc` | 1 | 01-api | `narrative_sections` | 2 | 2 | 2 | yes | **yes** | `apps\api\src\defense-budget\non-rdte\p21\p21-extractor-v1.ts` |
| `f692b7b9e286` | CleanUp3 | 01-api | `original_env` | 3 | 1 | 2 | yes | — | `apps\api\src\intelligence\news\news-catcher-dashboard.media.spec.ts` |
| `40bc5e3ac43a` | CleanUp3 | 01-api | `portal` | 3 | 1 | 2 | yes | — | `apps\api\src\funding-opportunities\funding-opportunity-outcome.spec.ts` |
| `692ad9efb7e5` | 1 | 02-web | `provider_options` | 2 | 2 | 2 | yes | — | `apps\web\src\pages\capiro-admin\AiKeysAdminPanel.tsx` |
| `2426674f658f` | 1 | 01-api | `quote()` | 3 | 1 | 2 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `acac65addd78` | CleanUp3 | 01-api | `revisedsections` | 2 | 2 | 2 | **no** | — | `apps\api\src\memory\memory-review-revision.helpers.spec.ts` |
| `015fc8d04efa` | CleanUp3 | 01-api | `rprow()` | 2 | 2 | 2 | yes | — | `apps\api\src\meri\meri-action-proposal.service.spec.ts` |
| `8a9ff41d4fc1` | CleanUp3 | 01-api | `shortestgraphpath()` | 2 | 2 | 2 | yes | — | `apps\api\src\meri\meri-graph-tools.helpers.spec.ts` |
| `2c8ebcf9d6d8` | 1 | 01-api | `side` | 2 | 2 | 2 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `07b227b68766` | CleanUp3 | 01-api | `source()` | 2 | 2 | 2 | yes | — | `apps\api\src\research-portfolios\research-portfolios.routes.contract.phase7.spec.ts` |
| `44ef777074e0` | CleanUp3 | 01-api | `standard` | 3 | 1 | 2 | yes | — | `apps\api\src\funding-opportunities\funding-opportunity-outcome.spec.ts` |
| `3f31e52e1e44` | 2 | 08-platform | `status` | 2 | 2 | 2 | **no** | — | `scripts\run-engagement-phase1-local.mjs` |
| `b97730bcd4ac` | 2 | 08-platform | `status` | 2 | 2 | 2 | **no** | — | `scripts\run-engagement-phase1-post-acceptance.mjs` |
| `ef8f34854642` | 1 | 02-web | `tone_options` | 2 | 2 | 2 | yes | — | `apps\web\src\pages\engagement\outreach\v2\StepGenerate.tsx` |
| `abc27f6221d7` | 1 | 04-meri | `trustedcurrentturnscope()` | 2 | 2 | 2 | yes | — | `apps\meriv2-orchestrator\src\meri\chat\chat.controller.ts` |
| `d66ba3c42512` | 1 | 01-api | `uniqueparticipants()` | 2 | 2 | 2 | yes | — | `apps\api\src\engagement\google\google-sync.service.ts` |
| `182bb2dc70c0` | 1 | 01-api | `unknownrecord` | 2 | 2 | 2 | yes | — | `apps\api\src\meri\meri-action-item-read.proof.ts` |
| `56a4915eb29a` | 1 | 01-api | `update()` | 3 | 1 | 2 | yes | — | `apps\api\scripts\backfill-assistance-awards-bulk.ts` |
| `0d66e3387f83` | 1 | 02-web | `usechangesets()` | 2 | 2 | 2 | yes | — | `apps\web\src\pages\strategy\api.ts` |
| `9c479fad9ab5` | CleanUp3 | 01-api | `uuid()` | 2 | 2 | 2 | yes | **yes** | `apps\api\src\defense-budget\governed-ingestion-manifest\ingestion-manifest-contract-v1.spec.ts` |
| `95d5df870cd0` | 1 | 01-api | `{ pglite }` | 3 | 1 | 2 | yes | — | `apps\api\test\community-funding-corpus-pglite.ts` |
| `9faafbccf880` | CleanUp3 | 01-api | `$queryrawunsafe()` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\governed-acceptance\defense-budget-ingestion-outbox-review-acceptance-v1.spec.ts` |
| `b988ab3ad9c9` | 1 | 06-intel | `.resolve()` | 2 | 1 | 1 | yes | — | `apps\intel-api\src\hearing\capture\automatic-stream-resolver.ts` |
| `9d18c5f3d6e6` | 1 | 01-api | `.updatemany()` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\promotion\canonical-promotion-repository-prisma-v1.ts` |
| `a0d8823f25c8` | CleanUp3 | 01-api | `a` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\funding-execution\funding-execution.v1.spec.ts` |
| `79981b951aa9` | CleanUp3 | 01-api | `adminctx` | 2 | 1 | 1 | yes | — | `apps\api\src\engagement\meeting-artifact-lifecycle.spec.ts` |
| `bb04a1ebb858` | 1 | 02-web | `apiedge` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `426dea041221` | CleanUp3 | 02-web | `apimock` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\broadcasts\VNextBroadcastAckGate.test.tsx` |
| `27c064c5b1a5` | 1 | 02-web | `apinode` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `f53f4bf0571a` | CleanUp3 | 02-web | `apipatch` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\pages\legiwatch\settings\committee-email-optin.test.tsx` |
| `ec39d735db93` | CleanUp3 | 01-api | `b` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\funding-execution\funding-execution.v1.spec.ts` |
| `a5fd00f94159` | CleanUp3 | 02-web | `capabilitiesbehavior` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.capabilities.test.tsx` |
| `6d75583599fa` | CleanUp3 | 02-web | `catalog` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\settings\IntegrationsPage.capabilities.test.tsx` |
| `d9e6bbb3c8cf` | CleanUp3 | 02-web | `client` | 2 | 1 | 1 | **no** | — | `apps\web\src\vnext\pages\client-crm\ClientNotetakerAction.test.tsx` |
| `62a45ea0244f` | 1 | 02-web | `clientlite` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\pages\funding-opportunities\FundingOpportunitiesPage.tsx` |
| `c5738967b19e` | CleanUp3 | 02-web | `clients` | 2 | 1 | 1 | **no** | — | `apps\web\src\vnext\pages\legiwatch\bills\bills-legacy-corpus.integration.test.tsx` |
| `73b3a0ce7462` | 1 | 02-web | `conf_label` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\BudgetLinePanels.tsx` |
| `6663d61f0e7d` | 1 | 02-web | `cover_groups` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\v2\PeV2SourcesTab.tsx` |
| `905952f13cc3` | 1 | 01-api | `create()` | 2 | 1 | 1 | yes | — | `apps\api\src\ingestion\sync-run.helper.ts` |
| `77ea61936546` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\meri\meri-research-child-task.pg.spec.ts` |
| `fcbad74fe16a` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\meri\meri-research-coordinator.service.spec.ts` |
| `e31ad92ef822` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\context\meetings-context-plane.runtime.spec.ts` |
| `32c132e32f11` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | **no** | — | `apps\api\src\meri\meri-report-read-authorization.spec.ts` |
| `c135ba200034` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\clients\crm-fill-evaluation.runner.spec.ts` |
| `eb75ebc7350f` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | **no** | — | `apps\api\src\research-portfolios\ResearchPortfolioClientFiling.spec.ts` |
| `2aa70c54946f` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\research-portfolios\research-portfolio-rules.service.spec.ts` |
| `08b9a4644941` | CleanUp3 | 01-api | `ctx` | 2 | 1 | 1 | yes | — | `apps\api\src\meri\meri-bizdev-tools.service.spec.ts` |
| `cbc6a262f7a7` | CleanUp3 | 04-meri | `ctx` | 2 | 1 | 1 | yes | — | `apps\meriv2-orchestrator\src\meri\api-client-context.repo.spec.ts` |
| `e36490a335ec` | CleanUp3 | 01-api | `ctxb` | 2 | 1 | 1 | yes | — | `apps\api\src\business-development\bizdev-brief.service.spec.ts` |
| `cb2356736ffa` | 1 | 02-web | `dollars2()` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\FyHistoryChart.tsx` |
| `a5ba70b80d5d` | CleanUp3 | 01-api | `ev()` | 2 | 1 | 1 | yes | — | `apps\api\src\business-development\bizdev-brief.service.spec.ts` |
| `f8853ede2021` | 1 | 02-web | `event_legend` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\BillsTouchingPePanel.tsx` |
| `14e3639fc48c` | CleanUp3 | 02-web | `feeditem()` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\clients\tracker\alert-actions-api.evidence.test.ts` |
| `1107bf71d638` | CleanUp3 | 02-web | `flag` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\bills\Bill360Page.test.tsx` |
| `865e6af99613` | 1 | 01-api | `flag()` | 2 | 1 | 1 | yes | — | `apps\api\scripts\send-pe-alert-emails.ts` |
| `e39fe25c79ee` | CleanUp3 | 01-api | `fundingassertion` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\contracts\adapters\committee-artifact-v1.adapter.spec.ts` |
| `a6ebf2c56485` | 1 | 08-platform | `fy2024` | 2 | 1 | 1 | yes | — | `scripts\phase8-session8-discovery-replay.mjs` |
| `09ed079ddf89` | 1 | 07-workspace-onboard | `gettoken` | 2 | 1 | 1 | yes | — | `apps\onboard-web\src\lib\capiro-api.ts` |
| `844e41f079c0` | 1 | 02-web | `graphresponse` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `9050957443c6` | 1 | 02-web | `layout` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `f223fff0391b` | 1 | 02-web | `legend` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\bills\BillEvidenceTab.tsx` |
| `7bee3259d43f` | 1 | 02-web | `mark_fields` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\FyDetailDrawer.tsx` |
| `de6dab0d684b` | 1 | 01-api | `measured` | 2 | 1 | 1 | yes | — | `apps\api\scripts\diag-funding-opportunities-makegov.ts` |
| `39779c43a5c8` | CleanUp3 | 02-web | `mocks` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\HearingPublicationsPanel.test.tsx` |
| `193a44cf2414` | CleanUp3 | 02-web | `mocks` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\HearingRecordingPanel.test.tsx` |
| `ee35db812b62` | CleanUp3 | 02-web | `mocks` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\pages\legiwatch\editorial\EvidenceTab.test.tsx` |
| `d276417cd0dd` | CleanUp3 | 01-api | `money()` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\funding-execution\funding-execution.v1.spec.ts` |
| `18a10aaccfe7` | 1 | 02-web | `money_stages` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\ProgramElementFinderPage.tsx` |
| `108042c2a3e8` | 1 | 02-web | `monotick` | 2 | 1 | 1 | yes | — | `apps\web\src\components\chat\AnalysisChartCard.tsx` |
| `83e90b91a041` | 1 | 01-api | `notprintedschema` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\stages\appropriations\conference\appropriations-conference-facts-v1.ts` |
| `535cad655159` | CleanUp3 | 05-strategy | `opa` | 2 | 1 | 1 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `53fb679ef885` | 1 | 02-web | `options` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\program-element\PeAlertEmailControl.tsx` |
| `7a80dad310d8` | CleanUp3 | 01-api | `opts` | 2 | 1 | 1 | yes | — | `apps\api\src\engagement\engagement-audience-type.spec.ts` |
| `5b956bba3f37` | CleanUp3 | 01-api | `otheruserctx` | 2 | 1 | 1 | yes | — | `apps\api\src\engagement\meeting-artifact-lifecycle.spec.ts` |
| `4bfebd6c4b65` | CleanUp3 | 01-api | `pe2` | 2 | 1 | 1 | yes | **yes** | `apps\api\src\defense-budget\phase6\phase6-negative-controls-final.spec.ts` |
| `39feb4e5be3a` | 1 | 01-api | `pe_identity` | 2 | 1 | 1 | yes | **yes** | `apps\api\scripts\phase6-producer-rehearsal.ts` |
| `f9e816fea862` | 1 | 08-platform | `peyearmatch` | 2 | 1 | 1 | yes | — | `scripts\verify-phase8-session6.mjs` |
| `b13334849f05` | CleanUp3 | 06-intel | `pipe` | 2 | 1 | 1 | yes | — | `apps\intel-api\test\action-item-dto-validation.spec.ts` |
| `ebe011d1545f` | 1 | 02-web | `preset_layout` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\panels\KnowledgeGraphPanel.tsx` |
| `41073f067b35` | CleanUp3 | 01-api | `processintent()` | 2 | 1 | 1 | yes | — | `apps\api\src\engagement\outreach-send-attachment-integrity.spec.ts` |
| `f20af0772600` | CleanUp3 | 04-meri | `question` | 2 | 1 | 1 | yes | — | `packages\meriv2-core\src\jev\calibrated-cascade.spec.ts` |
| `93b927fbc03c` | CleanUp3 | 01-api | `range` | 2 | 1 | 1 | yes | — | `apps\api\src\directory\legistorm\legistorm-client.spec.ts` |
| `3f9ffaf3eb4d` | CleanUp3 | 02-web | `rec()` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\engagement\outreach\v2\generation.test.ts` |
| `afafb5865ba8` | 1 | 01-api | `referencecolumn` | 2 | 1 | 1 | yes | — | `apps\api\src\hearing-discovery\florida-jlbc-alias-reconciliation.ts` |
| `3e93a64fe744` | CleanUp3 | 04-meri | `request()` | 2 | 1 | 1 | yes | — | `packages\meriv2-core\src\context\compiler-v2.spec.ts` |
| `89b2e96f837a` | CleanUp3 | 01-api | `reviewer` | 2 | 1 | 1 | yes | — | `apps\api\src\reviews\reviews-outreach.spec.ts` |
| `d177629a3e55` | 2 | 08-platform | `sha()` | 2 | 1 | 1 | **no** | — | `scripts\seed-phase8-session11-corpus.mjs` |
| `21dc03a3ffeb` | CleanUp3 | 01-api | `silentlogger` | 2 | 1 | 1 | yes | — | `apps\api\src\engagement\llm-completion-streaming.service.spec.ts` |
| `f37516feebc5` | 1 | 02-web | `sourcelink` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\pages\directory\StateCommitteesVNext.tsx` |
| `ae77f8b80370` | 1 | 01-api | `syncusageerror` | 2 | 1 | 1 | yes | — | `apps\api\scripts\sync-tango-entities.ts` |
| `f06751747a3e` | 1 | 02-web | `tabs` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\intelligence\federal-spending\FederalSpendingPage.tsx` |
| `ec9fceddc19e` | CleanUp3 | 02-web | `textarea()` | 2 | 1 | 1 | yes | — | `apps\web\src\vnext\meri\MeriSavedPromptWorkflow.phase4.test.tsx` |
| `1db0bc25748d` | CleanUp3 | 02-web | `threads` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\strategy\StrategyMeriPanel.chat.test.tsx` |
| `4e2540cfaf45` | CleanUp3 | 02-web | `watchlist` | 2 | 1 | 1 | yes | — | `apps\web\src\pages\clients\tracker\TrackerConfigPanel.email.test.tsx` |
| `e7d47ab66b1b` | CleanUp3 | 02-web | `wrapper()` | 2 | 1 | 1 | yes | — | `apps\web\src\components\chat\useMeriChatController.feedback.phase4.test.tsx` |
| `a73fd2ea2194` | CleanUp3 | 05-strategy | `wsplan()` | 2 | 1 | 1 | yes | — | `apps\api-strategy\src\agents\agent-safety.spec.ts` |
| `b05d75a7381f` | 1 | 03-defense | `{ annualdefensebudgetcyclecontroller }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `17bbb91ab120` | 1 | 08-platform | `{ budgetlifecyclequeryservice }` | 2 | 1 | 1 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `1a395cf349d3` | 1 | 08-platform | `{ cyclehealthservice }` | 2 | 1 | 1 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `e339f0d44997` | 1 | 03-defense | `{ defensebudgetlifecyclewatcher }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `59cca97e583c` | 1 | 03-defense | `{ httpssourcefetchadapter, govinfotextrenditionurl }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `820f0296ba31` | 1 | 03-defense | `{ inmemorylifecyclestore }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `163f5759b8ea` | 1 | 03-defense | `{ manifestsourcediscoveryadapter }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `2d7f9c8c4a02` | 5 | 08-platform | `{ package_root, classifyspecs }` | 2 | 1 | 1 | **no** | — | `infra\cdk\jest.jest-style.config.cjs` |
| `9e5800a7d6d2` | 1 | 08-platform | `{ prismabudgetlifecyclereadstore }` | 2 | 1 | 1 | yes | — | `scripts\verify-phase8-session11-integration.mjs` |
| `4676a6b79d96` | 1 | 03-defense | `{ prismalifecyclestore }` | 2 | 1 | 1 | yes | — | `apps\defense-api\scripts\run-lifecycle-watcher.mjs` |
| `85472bbf30b1` | 1 | 01-api | `{ runscenario, env }` | 2 | 1 | 1 | yes | — | `apps\api\scripts\perf\pe-profile.perf.js` |
