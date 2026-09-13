# Ten imported bill-keyword rules

Read-only database audit: 2026-09-13T12:24:40.714Z. Namespace `lobbytools:rubin-turnbull`. All rows have source prefix `2026-09-10:` and staged version 0. No typed rule is promoted or activated. A staged ID is not an active job ID.

| Source | Current staged UUID | Selections | Parser | Captured cadence | Email / in-app subscriptions | State |
|---|---|---:|---|---|---:|---|
| alert-29 | 041961a3-4318-4c8b-8884-af92ca5ab69a | 35 | supported individual definitions | Real time | 1/0 | requires_review |
| alert-30 | 7714d2c8-6552-4b51-8077-c64e7152726b | 1 | supported individual definitions | Real time | 0/1 | requires_review |
| alert-31 | fc1c3ca4-8db9-4b63-9261-3bf05bc3d49b | 75 | supported individual definitions | Real time | 1/2 | requires_review |
| alert-32 | 5b244fa0-bb17-47bb-84f8-8311d674a91a | 1 | supported individual definitions | Real time | 1/2 | requires_review |
| alert-33 | 6a4ffeda-2e9e-4618-9a5d-3361f40af5ea | 7 | supported individual definitions | Real time | 3/1 | requires_review |
| alert-34 | 06e86110-a526-43dc-9827-fb541e186f1e | 1 | supported individual definitions | Real time | 1/1 | requires_review |
| alert-35 | 25345cbc-60f7-476c-9035-926f5bc0c591 | 0 | empty | Real time | 1/1 | empty_blocked |
| alert-36 | 287b60fd-bbee-4ca1-87f7-f0922934445a | 6 | supported individual definitions | End of day | 2/0 | requires_review |
| alert-37 | 2a27852f-2ef4-48b5-9a9e-7792e32789b4 | 2 | supported individual definitions | Real time | 0/1 | requires_review |
| alert-38 | e2b00cd4-2b0d-4515-8e33-1e56d5921c2e | 17 | unsupported selected definition 32340 | Real time | 2/2 | requires_review |

190 raw definitions retained; 145 selected references; 118 distinct selected definitions. Of 190 definitions, 189 compile and one is unsupported. Definition 32340 **is selected in alert-38** and has ambiguous mixed AND/OR precedence; it must remain held rather than silently rewritten. Alert-35 is empty and must never match everything. Alert-36 is end-of-day regardless of its display name. No SMS consent is inferred.

Every row still requires explicit aggregation, current active owner, target folder(s), jurisdiction/session, document scope, current staff/channel mapping and a complete preview before any activation. The evidence does not establish an automatic target folder. Title matching can be qualified; full current text/amendment corpus coverage is incomplete and blocks that automation scope. No precision, recall or delivery success is inferred from parsing.

The private output `phase6-ten-rule-ledger.json` includes exact selected IDs and the full per-row gate matrix. `phase6-keyword-qualification.json` retains exact raw text, UTF-8 SHA-256 and compiled interpretations. Raw client expressions and recipient identities are not copied into this repository note.
