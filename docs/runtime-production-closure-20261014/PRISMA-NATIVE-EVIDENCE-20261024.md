# Prisma companion pins for General conversation bootstrap

The General bootstrap schema changes `ClioConversationBootstrapReceipt` to carry an explicit scope kind and nullable client. The raw image schema and actual generated client schema remain separately pinned. No runtime closure assertion or artifact probe was relaxed.

Native ARM diagnostic `capiro-preview-first-chat-core-build:ee997c8b-7557-4c1d-be2a-04862fb11e03` succeeded using the release's exact Node 22.23.3 Alpine ARM image, pnpm 9.12.0, frozen production manifests and Prisma 5.22.0. It generated clients directly from both frozen `793e6226` and current schema inputs. It published no image and accessed no database. Diagnostic archive SHA-256: `86cbc34960688baa22ffc656e04d108644f8597615f965a5bf3aa8327e2578ab`.

| Input / platform | Raw image schema SHA-256 | Actual generated companion SHA-256 |
|---|---|---|
| Frozen 793e / ARM64 | `db1ef525d50cd18e41dac1f397d5388bc716f199c90bacd4b587d3297c4e4df6` | `ba38a890bdf2c486eff198fefcc944a434423fb82327e1a8a3db447e92e9af87` |
| General / ARM64 | `5fcdd0e2be857713d39f874b1a13b029532b5d4a3b5bc94645b5bc665cf4c21e` | `e2bf86eaaf9924f31d815a8fb6ab022c6683b3630132284fa65ac75fab05e520` |
| General / x64 | `61c025bf396824034270f467caaa4832a4a143700f15f9f92442321cf9e4a061` | `4109e9fba63f56b26f5caaf2afcf94cce363efe75bb0e755a8253f49fcc46df1` |

The original schema inputs are `86c58644092e70ab67b5f01822a34b1ff9e33baacea647dddf85d0fdb460e4b3` (frozen) and `67539e80919a5080bd4285e784579356bc75430268ed0b6ee2322aec1ce96fbb` (General). The x64 source archive is `24fe32413d960479d1e82678a71f8e4bc5b9ad1eb700260ae14992ad12a2a263`; its actual Linux/musl generation, production Nest build and 26 focused integration tests passed. A separate disposable PostgreSQL 16 current-authority gate passed all 13 cases.

The failed frozen ARM production image reported package `prisma-client-ba38a890bdf2c486eff198fefcc944a434423fb82327e1a8a3db447e92e9af87`, matching the independent native diagnostic. Compared with x64 output after the target-string substitution, ARM generation changes one Unicode divider comment line for the frozen schema (line 4587), and two for the current General schema (lines 4588 and 12257). All other lines, including schema models, fields and relations, are identical. A host formatter emits different comment bytes and is not a valid substitute for the native generator. The host-only test making that equivalence claim was removed; mandatory native image checks still enforce exact raw and installed-companion hashes.

The canonical dependency closure generator was rerun. Its output remains byte-identical, SHA-256 `5cc0fc1104317cdae6627e3595f6a39ae3ad5d35397aaa0e5cd1e70e07366eaf`, because package manifests and the lockfile did not change. The final production ARM build, full image probes and exact-digest scan remain required after integration. These diagnostic and local passes are not deployment or browser acceptance.
