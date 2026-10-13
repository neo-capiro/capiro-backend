# Current source-qualified operator boundaries

The checked-in `scripts/lib/newsletter-accepted-source-profile.json` is pending: `activeCommit:null`, `acceptedSources:[]`. Before producing the next shipping artifact, a separately reviewed source-policy/spec change must bind the final accepted frontend commit/tree and exact qualification receipt repository/commit/path/SHA256. The candidate `c8aa693e884de86001d2fc04fbb60d48db09341c` is progress only; `7c87678730538958ace9762f824dc3e588bf445b` is preserved historical evidence. Neither is an active fallback. A caller flag, environment variable, branch name or manifest declaration cannot supply acceptance.

The existing local builder still takes twelve explicit operands. `--plan` validates syntax and returns pending admission without artifact filesystem access. `--run` refuses before artifact access until policy admission exists. Already-built standalone/public/static roots and exact manifest bytes must then pass the existing exhaustive path/link/byte/resource checks; this operator never builds Next, generates content, sends, uploads or invokes providers. The manifest is not rewritten and musl/Node24/architecture cannot be relabelled from a glibc build.

Reviewed invocation shape, not executed artifact production:

```sh
scripts/build-newsletter-release.sh --node-bin /absolute/node \
  --plan \
  --standalone-dir /absolute/standalone \
  --public-dir /absolute/public \
  --static-dir /absolute/static \
  --manifest /absolute/manifest.json \
  --manifest-sha256 <raw-manifest-sha256> \
  --source-repository neo-capiro/capiro-frontend \
  --source-commit <active-reviewed-frontend-sha> \
  --target-platform linux/amd64 \
  --target-libc musl --target-node-major 24 \
  --backend-source-commit <exact-reviewed-backend-sha> \
  --output-dir /absolute/release-artifacts/capiro-frontend
```

Changing `--plan` to `--run` requires active reviewed source admission and actual qualified inputs. `linux/arm64` is the other supported declared target. The explicit launcher clears inherited environment and runs Node with `--no-addons`. Output is `manifest.json`, `rootfs/**`, `build-receipt.json`; validation precedes output, with bounded positional reads, owned staging, same-output exclusive lock and publication rollback. Cooperative builder concurrency is covered; hostile namespace races and independent durability attestation remain open.

The existing consumer keeps exactly seven flags:

```sh
node scripts/lib/frontend-standalone-artifact-contract.mjs \
  --artifact-dir /absolute/release-artifacts/capiro-frontend \
  --manifest-sha256 <raw-manifest-sha256> \
  --source-repository neo-capiro/capiro-frontend \
  --source-commit <active-reviewed-frontend-sha> \
  --target-platform linux/amd64 \
  --target-libc musl --target-node-major 24
```

Docker's existing three explicit build arguments are `FRONTEND_ARTIFACT_MANIFEST_SHA256`, `FRONTEND_ARTIFACT_SOURCE_REPOSITORY`, `FRONTEND_ARTIFACT_SOURCE_COMMIT`; `TARGETPLATFORM` remains the declared Docker platform. The consumer copies the policy beside its owner and performs admission/byte checks before projecting the rootfs. Its exact base remains `node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2`, zlib1.3.2-r1, `USER node`, `/app`, port8080, `apps/web/server.js`. The default Web Docker and deployment workflow remain unchanged. No Docker command has been run here.

Current source/normal-document hygiene can be run read-only:

```sh
node scripts/lib/reviewed-source-hygiene.mjs --run --base b7aa1d6e6b341f833fa08b2add8f40d5fbee8480
```

PASS means every other changed tracked path passed fixed whitespace rules in both index and worktree while four exact immutable historical raw files were classified. Their observations remain in JSON; `wholePhysicalPatchWhitespacePass:false` is explicit. Altered archive bytes/modes, staged cancellation, attribute suppression and broad exclusions refuse.

The PE backend dry-run path is read-only at the driver level, but a package-manager invocation can synchronize dependencies. Use the independently reviewed finite source host for source qualification. The backend `--run` driver remains an explicit install/Prisma/database/native lane. Reuse the cleanup owner's isolated frozen-install/build receipt and request only genuine post-composition source deltas; do not duplicate heavy installs or touch its owned cluster. Source/synthetic/WASM checks never constitute native Postgres/RLS acceptance.
