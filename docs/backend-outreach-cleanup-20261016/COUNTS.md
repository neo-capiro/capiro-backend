# Source counts

Application/source checkpoint: `f69d4a1bdfe354d95daaffa273bd274d1bf89011`. The later evidence commit changes only this document packet. All values follow the original016e rules: nonblank authored code, including tests/scripts and retained support; generated/vendor/build/lock/docs/evidence/config-data buckets remain excluded. The copied runtime mirror was already reduced to zero code by accepted earlier cleanup and is not subtracted twice.

| Checkpoint | Unique nonblank code | Code files | Physical code lines |
| --- | ---: | ---: | ---: |
| Sealed PR36 a2 | 1,809,228 | 7,981 | 1,934,974 |
| This source checkpoint | 1,808,956 | 7,981 | 1,934,700 |
| Delta | -272 | 0 | -274 |

The production service contributes -372 nonblank/-377 physical lines; the old direct-private spec contributes -214/-226. New/current source controls contribute +314/+329. The historical ownership JSON and this evidence packet are excluded under the original rules.

Original016e unique code: 2,473,031 -> 1,808,956, down664,075 (26.85%). Including its separately measured copied runtime mirror: 2,664,875 -> 1,808,956, down855,919 (32.12%). These are source-size measurements, with no runtime/native acceptance implied. `CODE-COUNTS.json` records each of the five changed code blobs and the sealed-parent receipt hash; the bounded counter did not repeat a full repository scan.
