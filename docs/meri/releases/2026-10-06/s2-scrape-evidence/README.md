# Stage 2 s2-scrape-evidence (2026-10-06)

Source: main `f3e36015596b952d766ebcc101327408c5a4104a`.

The source re-check compares a scraped page by the text the producer read, not its raw bytes or links, and names changed fields on refusal (#2128). Follows T5 run 9 (00eb08de). Built from main f3e360155, which also carries LegiWatch #2122 (already served as API 619).

| Service | Image digest | Build |
| --- | --- | --- |
| api | `sha256:bbb902ae88b4…` | `956a39c1-be32-41e9-9085-791c9c8ce833` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
