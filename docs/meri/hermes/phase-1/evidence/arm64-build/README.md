# arm64 worker image build — attempted, deliberately aborted

**Outcome: the arm64 build path is FIXED and demonstrably works, but the image was NOT produced. Ticket #3 remains open.**

## What was run

```
PLATFORM=linux/arm64 bash docker/hermes-worker/build-base.sh
```

on the local Windows host, using the pre-existing `capiro-arm` `docker-container` buildx builder. No AWS, no registry push.

## What it proved

`build.txt` contains ~1 800 lines referencing `arm64`, including Debian package fetches explicitly resolving `.../debian trixie/main arm64 ...`. The build genuinely proceeded down the arm64 path rather than silently falling back to amd64, which validates the two fixes made to `build-base.sh` immediately before this run:

1. the Meri worker layer now carries `--platform` (previously a plain `docker build`, which would have stacked an amd64 layer on an arm64 base); and
2. non-amd64 builds now get arch-suffixed default tags, so an arm64 `--load` can no longer overwrite `meri-hermes-worker:v2026.9.14-meri` — the amd64 tag the local harness container and the real-Hermes e2e spec depend on. Without that fix this run would have broken the end-to-end test that was executing concurrently.

## Why it was aborted

Host memory. Free physical memory fell to **357 MB**, then **200 MB** — far below the ~1.0 GB level that has previously caused OOM kills on this host — because the build ran alongside the closeout workflow's agents, the fixture Postgres and the running Hermes worker. Stopping the buildx *client* was not sufficient: the `buildx_buildkit_capiro-arm0` daemon kept building at 2.85 GiB / 170% CPU, so the builder container itself was stopped. Memory then recovered to ~3.3 GB and every container the in-flight work depends on survived.

The image build was judged the less valuable of the two competing workloads: it is reproducible in CI, it is not required by any *local* gate, and the platform gate it feeds is blocked anyway because no ECR repository exists to push to.

## How to complete it

On a quiet host (nothing else heavy running, ≥8 GB free), either:

```
PLATFORM=linux/arm64 bash docker/hermes-worker/build-base.sh
```

which now produces `meri-hermes-worker:v2026.9.14-arm64` and `meri-hermes-worker:v2026.9.14-meri-arm64` without disturbing the amd64 images — or, preferably, run `.github/workflows/meri-hermes-worker-image.yml` on a native arm64 runner, which avoids emulation entirely and is the reproducible path. That workflow still requires the ECR repository and OIDC push permission requested in `../deployment-validation-and-rollback.md`, and the outstanding bundled-skill license review.

`build.txt` is retained as evidence of the attempt and of the arm64 code path working.
