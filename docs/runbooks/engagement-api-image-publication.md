# engagement-api Image Publication

**Micro-session:** 2.10 · **Script:** `scripts/engagement-api-image.sh`
**Spec:** `scripts/engagement-api-image.spec.mjs`

Publishing an image and running it are **separate authorization gates**. This
script never deploys.

---

## Commands

| Command | What it does | Mutates AWS |
|---|---|---|
| `build` | ARM64 build, then assert the image is nonroot, serve-only, and free of bundled UI | no |
| `push` | Log in to ECR and push the exact release-SHA tag | **yes** |
| `describe` | Resolve the immutable digest and scan metadata | no |
| `verify-scan` | Fail on an incomplete scan or Critical findings | no |
| `inspect` | Re-run the image assertions against an existing local image | no |

---

## Required environment

```bash
export RELEASE_SHA=<40-hex git sha>      # this is the ONLY tag
export CAPIRO_ENV=dev                    # dev | staging | prod
export AWS_REGION=us-east-1
export EXPECTED_AWS_ACCOUNT_ID=<account>
```

Optional: `REPOSITORY_URI`, `HIGH_FINDING_BASELINE` (default 0), `DOCKER_BIN`,
`AWS_BIN`, `NODE_BIN`, `ENGAGEMENT_IMAGE_OUT_DIR`.

---

## Sequence

```bash
scripts/engagement-api-image.sh build

# Push requires a confirmation token naming exactly what is about to happen.
export CONFIRM_ENGAGEMENT_IMAGE_PUSH="${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:${RELEASE_SHA}"
scripts/engagement-api-image.sh push

scripts/engagement-api-image.sh describe      # writes image-digest.txt
scripts/engagement-api-image.sh verify-scan
```

Then put the resolved digest into the deployment config as `imageDigest` and
re-synth. The Service stack refuses to synthesize without it.

---

## Why `latest` is structurally impossible

The tag is not a parameter — it **is** `RELEASE_SHA`, validated as 40 lowercase
hex characters before any `docker` call runs. Passing `RELEASE_SHA=latest` exits
1 with zero docker invocations; a test asserts the call log is empty. There is
no code path that composes a different tag.

---

## Gates

`build` fails when the image is not `linux/arm64`, runs as root, has a `CMD`
other than `["serve"]`, lacks the serve-only entrypoint, or bakes a forbidden
variable (`OUTREACH_V3_ENABLED`, `LANGGRAPH_*`, `CAMPAIGN_SPEC_*`, `VITE_*`) or
UI asset content.

It also **probes the running image**: `migrate`, `migration-status`, `seed`,
`sync-*` and `diag-*` must each exit **64**. An image that accepts `migrate`
fails the build. This is a behavioural check, not a config assertion.

`push` fails without `CONFIRM_ENGAGEMENT_IMAGE_PUSH` set to
`<account>:<region>:<release-sha>`, when the caller's account does not match,
and when the tag already exists — the repository is immutable, so failing early
gives a clear message instead of a registry error.

`describe` fails unless exactly one image matches, the digest is
`sha256:` plus 64 hex, and the tag set contains the release SHA and **not**
`latest`.

`verify-scan` fails when the scan status is anything other than `COMPLETE`,
when any Critical finding exists, or when High findings exceed
`HIGH_FINDING_BASELINE`. **An incomplete scan is not a pass** — "we do not know
yet" must never read as "clean" at a deployment gate.

---

## The image contains no Outreach V3 UI

It is the accepted shared Engagement backend runtime and nothing else. The
prototype is an external input frozen by checksum in the Phase 2 input lock and
must never enter the repository or an image layer.

The two `OUTREACH_V3_*` hashes are **runtime metadata on the task**, injected by
the Service stack — not content in the image. `build` fails if either turns up
baked into the image environment.

---

## Evidence

Written to `.artifacts/engagement-phase2/<env>/`:

```text
image-inspect.json    architecture, user, entrypoint, CMD
image-describe.json   digest, pushed-at, manifest media type, scan status
image-digest.txt      the digest to paste into the deployment config
image-scan.json       severity counts
```

---

## Rollback

Never retag or mutate a published image; the repository is immutable and a
digest is the only safe reference. To roll back, set the previous known-good
digest in the config and redeploy the Service stack. Record both digests.
