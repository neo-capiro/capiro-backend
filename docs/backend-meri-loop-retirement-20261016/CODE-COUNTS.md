# Source counts

Source checkpoint: `0a83ced7744932c42e17db084b30b0a9810c4699`. The unchanged original016e classification counts authored source, comments, tests, scripts and retained frontend support by nonblank UTF-8 lines. Configuration/data, locks, documentation/evidence, assets, dependencies, generated output and builds retain their original separate treatment. This is a finite changed-Git-blob delta from sealed PR34, not another full scan.

| Measure | PR34 before | This successor | Delta |
| --- | ---: | ---: | ---: |
| Unique authored nonblank source | 1,811,365 | 1,809,228 | −2,137 |
| Unique code files | 7,981 | 7,981 | 0 |
| Physical source lines | 1,937,177 | 1,934,974 | −2,203 |
| Copied defense runtime code | 0 | 0 | 0 |

Application source loses 3,083 nonblank lines; current regressions, replay planner and catalog support add 946. Seven retired source/test files are balanced by seven new source/test support files. Historical case metadata is classified as JSON data under the existing rules, not as a copied active runtime.

Across the published cleanup stack, unique authored source is **2,473,031 → 1,809,228**: 663,803 fewer nonblank lines (26.84%). Including the original separately counted 191,844-line runtime mirror, physical copied/authored code is **2,664,875 → 1,809,228**: 855,647 fewer (32.11%). The unique original headline already included Web/Onboard source; these reductions do not subtract it twice.

`CODE-COUNTS.json` records every changed path/blob and the sealed parent receipt hash. Counts describe source size, not native coverage, production availability or runtime adoption.
