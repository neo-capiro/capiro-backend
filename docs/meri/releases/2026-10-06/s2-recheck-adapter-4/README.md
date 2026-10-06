# Stage 2 s2-recheck-adapter-4 (2026-10-06)

Source: main `c9f570eee3490147330492fd1acef95b9cbe6763`.

Undeclared receipts from dropped bounded children no longer block a report (#2058): one qualification helper decides declared sources and the classifier refuses any receipted read the model saw that is not declared. Also carries #2052 (LegiWatch committee ingestion, another workstream); its migration 20281008020000_legiwatch_committee_news_update_type was already applied (migration-status on this image: up to date, admin-migrate 87). No migration applied by this roll.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:4cdba7f7aa83…` | `4cb826e7-1c2c-4033-8ab2-f2e3fb5650d1` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
