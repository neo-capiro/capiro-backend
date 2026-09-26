# Meri private recall-wrapper dead-leaf audit

Date: 2026-09-25. Scope: source-only removal of the private `MeriService.resolveMemoryRecallSource` wrapper and its stale comment. This is not V1/V2/V3 runtime retirement.

Before removal, `rg -n -F 'resolveMemoryRecallSource' .` found only the wrapper declaration in `apps/api/src/meri/meri.service.ts`; no production call, spec, or dynamic registration named it. The live `loadRelevantMemories` path calls `resolveRecallConfig(tenantId)` directly, preserving its `mode`, `rerankOn`, and `graphOn` decisions. The Meri controller still receives the `MeriService` proxy; the module still registers the raw service and the V3→V2→V1 fallback. None of those bindings or branches changes here.

Graphy was available but could not provide a current reachability proof: this worktree has no index, and the pre-existing `C:\dev\main` index reports zero nodes, edges, and indexed files. No new index was created under the RAM/testing hold. The deletion decision rests on current-tree reference search and direct call-site/registration inspection, not stale Graphy or traffic telemetry. `git diff --check` is the only check run; Jest, typecheck, build, and deployed QA remain deferred.
