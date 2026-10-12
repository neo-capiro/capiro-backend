# Meri local dispatch conversion

This source-only conversion replaces the existing `MeriToolsService.executeScoped` switch with a local table of 134 lazy callbacks. The existing canonical shared `MeriCapability` union supplies the name type; the table is an implementation of the existing owner, not another capability catalog. The five `federal_market` capabilities retain their existing governed proxy owner and are refused by local dispatch.

`assertMeriToolRequestActive()` remains the first executed statement. Table construction reads no `this` properties, providers, inputs, or execution metadata. `executeMeriLocalDispatch` synchronously selects a primitive string own property and invokes its zero-argument callback; other keys call the existing `assertNever` function, including its existing interpolation/error behavior. The containing method remains async. Synchronous exceptions still reject its Promise; leaf Promises/thenables retain the existing adoption boundary.

Every callback preserves the frozen switch's target, receiver, argument order/arity, input identity and evaluation order. Only `send_email`, `create_word` and `schedule_task` read `execution?.actionProposalId`. Word format validation precedes the owner call. District fallback still tests the immediate nullable owner return, before any Promise adoption. Funding adapters retain their existing coercions and shapes. BizDev owner lookup remains lazy.

The Research Portfolio callback retains the original return statement byte-for-byte and uses the unchanged `executeMeriResearchPortfolioToolAtCurrentUse` canonical authority wrapper. Current-turn actor/client/conversation checks, fresh conversation scope revalidation, refusal and infrastructure errors precede lazy `requireResearchPortfolioTools`. LegiWatch still receives `(ctx, name, input)` through its existing owner.

No private method is exposed; no DI, module, governed proxy, request-policy, ALS, persistence, shared capability, normalization or alias policy changes. The service outside this method body and the one new import is byte-identical to the reviewed base, including Q's pending-memory wording.
