# Stage 2 s2-recheck-adapter-2 (2026-10-06)

Source: main `30fd674d091f4e86b266e5a5c9e22086e5c26194`.

Producer-input re-check reads memory as the reader (#2054): sets app.current_user for the check so the reader's own user-private steering items are visible under memory_items' forced owner RLS. Fixes the context_packet_item_missing refusal seen on the first live check after the s2-recheck-adapter roll (#2051). No migration.

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:d9e76278d18e…` | `c7588dfa-b4d6-41ed-8177-4fd508748737` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
