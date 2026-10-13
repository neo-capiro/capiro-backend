# Actual PR52 client on the owned HTTP seam

Frozen wrapper/binding source: `0b49070d0f18afea933af9312d63921b276ee4e0` / tree `481dd8066d0375403a452f6e029725cf7c80dc81`. Source files are this task's `consumeOwnedHttp.mjs` and metadata-only `CLIENT-STAGE-BINDINGS.json`. No private Meri implementation body or fixture is committed. Root is the integration/publication owner.

The seven exact pure modules from Meri PR52 `4699fdea910ba25c809725630443198c8ae189e4` / tree `61c076225b4d9a3aba431a83342e028a3f7b60ca` are staged outside Git at `/tmp/capiro-meri-pr52-private-client-stage-20261013`, totaling 69,599 bytes. A task-local symlink borrows `/workspace/meri-greenfield/node_modules`. Source hashes, exact Node24.19 identity, package metadata and actual Ajv2020/ajv-formats/canonicalize entry identities are checked before private imports. The metadata binds the complete fixed seven-module inventory; it is not a claim of OS isolation or exhaustive byte qualification of all third-party transitive package files. No install, generator, native download or cache mutation occurred.

`consumeOwnedHttp({origin,credential,fetchImpl,conversationId,clientId})` matches the optional consumer seam in E's frozen HTTP driver `184da5ef70c0fd79bf7f099a8d98a7d17c679d0f` / tree `921d5b57ff0944f4f4267fe37f5edec36c262c75`. It accepts only the synthetic origin/credential alias, forwards only the two exact `/api/clio/application-authority/` URLs and unchanged fixed request options, and delegates E's already approved URL-to-owned-127 mapping. The wrapper generates neither JSON success receipts nor native Response objects. It invokes the real PR52 transport, private request/receipt validators and actual canonical hash. Identity/context principals, revisions, exact selectors, digest echo and current local request/receive time bounds must match. It introduces no currentRun/scopes/fences/grants/approval authority and no production HTTP/TLS exception.

Only the actual parsed successful identity/context, canonical identity digest, public source hashes, timeline and explicit qualification limits are returned. The credential and internal error bodies are never returned; failures are content-free. Negative native case bodies stay with their native owner. The earlier read-only PR52 receiving contract and historical PR47 pins remain in the separate immutable plan packet.

Syntax-only `node --check` exits 0. It evaluates no module, private import, HTTP or database operation. The source was sent to E for independent review. Actual execution remains PENDING Root's concrete command approval. E reported its first real HTTP/native 45-case run separately; this task does not duplicate that corpus or adopt its private raw packet.

The proposed single-pair invocation uses the exact E184 driver and containment preload, an exclusive new output and a Root-owned configuration that preserves the approved private target while setting `runAuthorCases:false` and this wrapper's absolute `privateClientConsumer` path. This configuration is prepared by Root; this worker does not read or create DSN/credential values. The command shape is:

```sh
env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin LANG=C.UTF-8 TZ=UTC \
/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
--require /tmp/capiro-meri-http-harness-20261013/docs/meri-application-authority-http-qualification-20261013/containment-preload.cjs \
/tmp/capiro-meri-http-harness-20261013/docs/meri-application-authority-http-qualification-20261013/http-driver.cjs \
<Root-owned one-pair runtime JSON> \
<exclusive new owned output JSON>
```

This is a proposed shape, not an executed command or blanket permission. Root first fixes the concrete paths/target and approves execution; driver/source/dependency hashes must remain exact. It yields one private-client pair with zero replay of E's 45 author cases. Native target assertions and all E-owned fixture/SQL/lifecycle behavior remain the driver's responsibility, so Root also coordinates any concurrent RLS lane using that database. Actual no-store/content headers and raw UTF-8/checksum custody remain E's safe synthetic producer handoff. A pair does not qualify whole-app bootstrap, live Clerk, TLS, a production origin, deployed Meri or Meri's borrowed currentRun/admitted command-context authority.
