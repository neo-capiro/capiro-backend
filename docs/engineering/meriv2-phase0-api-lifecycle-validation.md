# MeriV2 Phase 0 API Lifecycle Validation

Base commit: 1cdd372f0409986ac238beef2c4e9f310925fb37
Workflow run: https://github.com/neo-capiro/capirov2/actions/runs/30327138829
Result: FAIL

```text
$ pnpm --filter @capiro/shared build

> @capiro/shared@0.0.0 build /home/runner/work/capirov2/capirov2/packages/shared
> tsc -p tsconfig.json

exit_code=0
$ pnpm --filter @capiro/meriv2-core build

> @capiro/meriv2-core@0.0.0 build /home/runner/work/capirov2/capirov2/packages/meriv2-core
> tsc -p tsconfig.json

exit_code=0
$ pnpm --filter @capiro/api prisma:generate

> @capiro/api@0.0.0 prisma:generate /home/runner/work/capirov2/capirov2/apps/api
> prisma generate

Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v5.22.0) to ./../../node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client in 2.19s

Start by importing your Prisma Client (See: https://pris.ly/d/importing-client)

Tip: Need your database queries to be 1000x faster? Accelerate offers you that and more: https://pris.ly/tip-2-accelerate

exit_code=0
$ pnpm --filter @capiro/meriv2-core typecheck

> @capiro/meriv2-core@0.0.0 typecheck /home/runner/work/capirov2/capirov2/packages/meriv2-core
> tsc -p tsconfig.json --noEmit

exit_code=0
$ pnpm --filter @capiro/meriv2-core test -- --runInBand src/compliance/action-approval.spec.ts src/compliance/compliance-rules.spec.ts

> @capiro/meriv2-core@0.0.0 test /home/runner/work/capirov2/capirov2/packages/meriv2-core
> jest --detectOpenHandles --forceExit "--runInBand" "src/compliance/action-approval.spec.ts" "src/compliance/compliance-rules.spec.ts"

PASS src/compliance/compliance-rules.spec.ts
PASS src/compliance/action-approval.spec.ts

Test Suites: 2 passed, 2 total
Tests:       34 passed, 34 total
Snapshots:   0 total
Time:        2.674 s
Ran all test suites matching /src\/compliance\/action-approval.spec.ts|src\/compliance\/compliance-rules.spec.ts/i.
exit_code=0
$ pnpm --filter @capiro/api typecheck

> @capiro/api@0.0.0 typecheck /home/runner/work/capirov2/capirov2/apps/api
> tsc --noEmit

exit_code=0
$ pnpm --filter @capiro/api test -- --runInBand src/meri/meri-write-tool-input.spec.ts src/meri/tool-service-secret.guard.spec.ts src/meri/meri-approval.service.spec.ts src/meri/meri-action-proposal.service.spec.ts src/meri/meri-action-proposal.http.spec.ts

> @capiro/api@0.0.0 test /home/runner/work/capirov2/capirov2/apps/api
> jest --detectOpenHandles --forceExit "--runInBand" "src/meri/meri-write-tool-input.spec.ts" "src/meri/tool-service-secret.guard.spec.ts" "src/meri/meri-approval.service.spec.ts" "src/meri/meri-action-proposal.service.spec.ts" "src/meri/meri-action-proposal.http.spec.ts"


<--- Last few GCs --->

[2428:0x35ebd700]    73481 ms: Scavenge 2039.5 (2084.5) -> 2037.8 (2084.5) MB, 2.25 / 0.00 ms  (average mu = 0.313, current mu = 0.318) allocation failure; 
[2428:0x35ebd700]    73486 ms: Scavenge 2039.7 (2084.5) -> 2037.8 (2084.5) MB, 1.44 / 0.00 ms  (average mu = 0.313, current mu = 0.318) allocation failure; 
[2428:0x35ebd700]    73492 ms: Scavenge 2039.8 (2084.5) -> 2037.9 (2088.5) MB, 2.03 / 0.00 ms  (average mu = 0.313, current mu = 0.318) allocation failure; 


<--- JS stacktrace --->

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
----- Native stack trace -----

 1: 0xb78db3 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]
 2: 0xee8300 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]
 3: 0xee85e7 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]
 4: 0x10fb205  [node]
 5: 0x10fb794 v8::internal::Heap::RecomputeLimits(v8::internal::GarbageCollector) [node]
 6: 0x1112684 v8::internal::Heap::PerformGarbageCollection(v8::internal::GarbageCollector, v8::internal::GarbageCollectionReason, char const*) [node]
 7: 0x1112e9c v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]
 8: 0x10e91f1 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]
 9: 0x10ea385 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]
10: 0x10c78d6 v8::internal::Factory::NewFillerObject(int, v8::internal::AllocationAlignment, v8::internal::AllocationType, v8::internal::AllocationOrigin) [node]
11: 0x15247d6 v8::internal::Runtime_AllocateInYoungGeneration(int, unsigned long*, v8::internal::Isolate*) [node]
12: 0x7f53f8e9a476 
Aborted (core dumped)
/home/runner/work/capirov2/capirov2/apps/api:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @capiro/api@0.0.0 test: `jest --detectOpenHandles --forceExit "--runInBand" "src/meri/meri-write-tool-input.spec.ts" "src/meri/tool-service-secret.guard.spec.ts" "src/meri/meri-approval.service.spec.ts" "src/meri/meri-action-proposal.service.spec.ts" "src/meri/meri-action-proposal.http.spec.ts"`
Exit status 134
exit_code=134
```
