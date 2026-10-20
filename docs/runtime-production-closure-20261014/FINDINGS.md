# Production dependency closure correction: source only

Base: backend PR26 ae47e74f7b34c447f92d05d425940369731aaba9 / tree63212633d101a6ae26d46bcf1f9e7bf1ef4215f5. No AWS/build/native/provider/model execution or deployment. Shipping owns collector adaptation; its three existing collector paths are untouched here.

## Exact dependency and application roots

API package apps/api/package.json and workspaces packages/shared, packages/meriv2-core, packages/defense-contracts, packages/defense-domain supply the declared production roots. Complete lock9 BFS includes mandatory and optional dependency edges, workspace links, aliases and exact peer-context snapshot IDs:515 package snapshots,1011 edges including importer edges, zero unresolved references. RUNTIME-CLOSURE-CONTRACT.json is stable and contains all snapshot/platform/integrity metadata plus seven source input hashes; sourceAudit/head/time live separately in PRODUCTION-CLOSURE.json.

Root package.json declares promptfoo0.123.1 only in devDependencies. Its optional dependencies include @openai/codex-security0.1.31 and @huggingface/transformers4.3.0; transformers depends on onnxruntime-node1.30.0 and onnxruntime-web1.31.0-dev. None is reachable from the five production roots. The source audit inspects API src/scripts and all four workspace src trees; no application literal reference to these target packages was found. Negative lexical results alone would be insufficient; the complete declared dependency closure independently excludes them.

Operational entrypoint: entrypoint.sh → entrypoint-legacy.sh → apps/api/scripts/entrypoint-dispatcher.inc; serve runs node dist/main.js → AppModule. Other supported verbs execute copied TS scripts through production tsx. All compiled/source/script/data/Prisma roots remain copied unchanged. The current embedding seam is embedder.ts → embedding-provider.factory.ts → TitanEmbeddingProvider; it does not select transformers or ONNX. No provider invocation was performed.

## Retention defect and minimal correction

An offline synthetic pnpm9.12.0 fixture using local tarballs reproduced the Docker sequence. Filtered build installation includes the root development package. Filtered in-place --prod installation leaves both its root link and virtual-store package. A fresh --prod installation creates only the used production package. See PNPM-FIXTURE-RESULT.json and fixture provenance. These are real package-manager operations on synthetic inert packages, not an ARM64 image build.

The Docker candidate adds production-deps FROM the same pinned base and installs identical frozen manifests/lock into an empty workspace. It regenerates Prisma using the build's already image-local musl generator target. Runtime node_modules (root, API, meriv2-core and defense-domain) come from this stage. Compiled application/source/script/data artifacts still come from build. Production tsx, Prisma, canvas and esbuild stay in the derived closure. No source dependency, lock, base image, platform, environment, entrypoint or application behavior was changed. No named package removal, path exclusion, rm allowlist, gate bypass or dev-owner exception was introduced.

Sharp, LibSQL and SWC also fall outside this declared production closure. Shipping must adapt collector expectations to the exact reviewed graph rather than retain development tooling merely to satisfy old probes. Both mandatory Docker final gates remain unchanged in this candidate, so it is intentionally not admissible with the old collector contract. No paid attempt should start from this intermediate source.

## Vendor selector evidence and classification limits

Exact public npm archives were SHA512 verified against the pinned versions and their integrity values matched both exact pnpm-lock package records. Only JS/TS/manifests and compressed JavaScript chunks were retained; native binaries were not extracted or executed, and no models were downloaded. Source hashes/archive provenance are in vendor-source/PROVENANCE.json.

Codex Security helpers.mjs decompresses JavaScript chunks and compiles that runtime. The decoded selector reads platform/arch and Linux process.report.header.glibcVersionRuntime. On Linux ARM64 musl it selects native/linux-arm64-musl/unix.node, which IS present in the eight published payloads. The other seven platform variants are unselected by this exact branch under that platform input. An initial absence inference from the seven HOLD rows was incorrect and corrected by the verified archive index. Selection tests execute only that pure branch with a mocked require; they do not run the vendor plugin or load an addon.

ONNX's compiled binding.js selects bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node. On this target the branch selects linux/arm64; it has no libc condition. The five alternate payload paths are unselected by that binding branch on Linux ARM64. An actual ONNX inference remains unrun and cannot be replaced by selector/source facts.

For the old retained diagnostic image, classification is DEV_ONLY_OUTSIDE_DECLARED_PRODUCTION_CLOSURE with conditional vendor platform selection, not deployed-inactive admission. For a future fresh-production image, require installed-resolution graph proof and complete store-owner inventory showing these dev-only packages absent. Unexpected packages/native payloads remain HOLD. Neither source imports nor package absence substitutes for actual AppModule startup, current authorized application qualification or scan admission.

## Required next review/admission

Shipping's graph gate must verify input hashes, actual API/workspace dependency resolution, exact peer/integrity/platform identities, all required edges and justified optional absence, then reject every retained store owner outside the graph before ANY native execution. This candidate must COPY its reviewed helper, stable contract, frozen lock and root manifest to fixed /qualification paths in coordination with shipping. That binding delta is pending the helper's exact source pin.

Byte custody: the initial Windows checkout/PowerShell export used CRLF bytes and is superseded. The generator now binds all seven contract input hashes to immutable Git blobs after proving the checkout differs only by permitted line endings; semantic drift fails. Programmatic --out writes actual LF bytes. Canonical lock SHA256 is01f689e46dc06cdd1d9e8a0c96e5b6e70ac6f462fe2ab9c05813317a053c643c. Runtime must verify exact source-archive bytes at the fixed paths, without normalizing image inputs to rescue a mismatch.

Only after the combined Docker/audit/collector slices have exact head/tree review should an independently approved bounded native/startup/scan plan execute. Installed ARM64/musl dependency tree, generated Prisma, runtime CLI links, complete native inventory, AppModule startup and COMPLETE zero-High/Critical scan remain UNRUN here.
