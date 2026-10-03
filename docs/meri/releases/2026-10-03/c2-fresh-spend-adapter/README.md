# Existing fresh journal: native capture adapter

The native01/20 collectors can now use the existing fresh-spend journal through their original opaque reservation/settlement authority. The adapter pins the exact authorization and20-event prefix, preserves the five settled attempts and$9.841281 spent, and keeps the$30 aggregate/$15 per-case/concurrency1 limits. The remaining balance is$20.158719. Older unresolved costs remain separate.

Adoption is read-only and creates no replacement ledger or sidecar. Future reservations and authenticated settlements append to the same JSONL under native Windows handle locking, identity/hash comparison, flush and full readback. Invalid, stale, competing, partial or uncertain states block; interrupted reservations retain their ceiling and have no automatic recovery/refund.

[Independent review](review.json) passed for the exact [checkpoint](checkpoint.json). Twelve actual NTFS tests and five capability tests passed using disposable copies; actual journal/authorization bytes and clock/memory source stayed unchanged. The two production files and two tests are committed separately from the clock candidate. No live adoption, journal mutation, authenticated positive settlement, fixture action, provider call or original acceptance occurred. Runner integration and canonical current fixture/rate/build qualification remain pending.

[Evidence hashes](artifacts.json) preserve the recorded test results. The actual private journal and authorization remain at their original paths and are not copied into this archive.
