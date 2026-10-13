The canonical local builder is implemented and physically tested. It assembles approved already-built frontend output into the existing opt-in Web Docker consumer, with canonical byte/link/trace validation, an immutable output, a synced receipt and explicit source/runtime pins. The four formerly held packaging/workflow paths are resolved on the current receiving source. The existing default image, deployment workflows, package/lock/workspace and full acceptance gates remain unchanged.

Use the [complete operator and manifest preparation instructions](../cleanup-newsletter-canonical-builder-20261013/OPERATOR.md). The approved producer must supply the three existing input roots, measured manifest SHA and source/platform evidence. The builder performs assembly; its receipt keeps source-build, native/runtime/UI/deployed and shipping acceptance false. Actual approved output/manifest was absent at both known canonical receiving locations.

The output must be at `release-artifacts/capiro-frontend` for the opt-in consumer. These are the complete seven validator flags:

```sh
"$TRUSTED_NODE24" --no-addons scripts/lib/frontend-standalone-artifact-contract.mjs \
  --artifact-dir "$NEW_OUTPUT" --manifest-sha256 "$PRODUCER_MANIFEST_SHA256" \
  --source-repository neo-capiro/capiro-frontend \
  --source-commit 7c87678730538958ace9762f824dc3e588bf445b \
  --target-platform "linux/$ARCH" --target-libc musl --target-node-major 24
```

Once a separate native image-build action is authorized, the existing Docker interface consumes that validated output with exactly three explicit provenance arguments. This command is documented for review and was not run:

```sh
docker build --platform "linux/$ARCH" --file apps/web/Dockerfile.frontend-artifact \
  --build-arg "FRONTEND_ARTIFACT_MANIFEST_SHA256=$PRODUCER_MANIFEST_SHA256" \
  --build-arg FRONTEND_ARTIFACT_SOURCE_REPOSITORY=neo-capiro/capiro-frontend \
  --build-arg FRONTEND_ARTIFACT_SOURCE_COMMIT=7c87678730538958ace9762f824dc3e588bf445b .
```

The pinned consumer remains Node24.21.0/Linux musl/Alpine3.23, `USER node`, `/app`, port8080 and `apps/web/server.js`. A glibc declaration refuses. Declared target equality does not prove native compatibility. Valid internal directory aliases, public/.next/static placement, BUILD_ID, required-server-files and included traces remain with the existing canonical owner. Production byte admission requires all179 known Newsletter assets totaling486014 bytes; donor3054-file/5208-trace counts are not thresholds.

Root qualification passes354 current cases plus four direct CLI checks:32 physical synthetic assembly cases,50 canonical standalone,3 Docker source contracts,90 static guards,91 backend/source scopes,30 current-source edge declarations,53 owned loopback transport cases and5 workflow controls. The loopback host recorded29 owned ephemeral servers/742 connections, all closed, with no remaining ports. Synthetic fixtures do not qualify actual asset bytes or native/app/live serving. Author/independent indices, source inverses, original failed controls and all source heads are retained in [COMPOSITION.json](COMPOSITION.json) and the master index.

The two-path edge header repair is separately published in [draft PR2443](https://github.com/neo-capiro/capirov2/pull/2443), exact head `b7aa1d6e6b341f833fa08b2add8f40d5fbee8480`, tree `ebc1248a4eead209816142791c09681980ecd148`. It is an inert projection of nine pinned source operands and establishes no production routing defect. Its independent30 model cases,90 immutable header controls,29 supplementary checks and8 host refusals pass.

The [single current handoff and overlap matrix](../cleanup-retirement-additional-reviewed-inputs-20261012/HANDOFF.md) records the compatible stack and remaining actions. Native image/ABI/runtime/health, actual179GET+HEAD at the public origins, approved capability/query/body/upload/font-CORS fixtures, actualAPI_PUBLIC_URL/WEB_PUBLIC_URL and retainedHTML relative resolution, browser flows, complete ordered HTTPS listener/targets and DNS/TLS are unqualified. Preserve PR2440's exact acceptance operands at891. Four historical header differences require actualHTTPS measurements; managedCDK source does not establish the manually managed live ALB. Existing authorized shipping checks remain held until their route is restored, with no automatic retry or deployment here.

All changes are source or owned synthetic fixtures. No real messages/uploads/provider/paid-model calls, customer mutations, AWS, credentials/permission/security/network changes, database/migration execution, main merge or deployment occurred. Protected unpublished reporting and separately pending native publication remain with their owners. Full historical whitespace and release floors remain open; raw evidence is preserved without trimming or waivers.
