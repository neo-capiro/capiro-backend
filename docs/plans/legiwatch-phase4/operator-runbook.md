# Phase 4 operations and release

This runbook is being filled from inspected implementation and runtime evidence.
Do not execute a release from this initial baseline checklist.

1. Recheck current main, HTTP and worker image digests, migration ledgers,
   schedules, gates and active captures against the engineering note.
2. Qualify additive migrations on isolated PostgreSQL using each service's owner.
3. Qualify immutable native ARM64 images without mutable latest publication or
   unrelated service restarts. Preserve newer releases and active recordings.
4. Deploy compatible backend contracts, private media storage permissions and
   workers before the UI. New retained media and outward delivery gates start off.
5. Activate only qualified tenant/source/channel scope with concrete evidence.
   Four-hour browser and unattended runs are independent gates. Real recipients
   and provider contact require explicit session authorization.

Rollback holds new Phase 4 launches and unsent outward work first. Preserve
saved audio, transcripts, approved versions, consent and delivery history.
Disabling a scheduler does not stop an active capture; use the qualified explicit
per-capture stop only when intended. Never clear queues or re-send uncertain
provider outcomes to make the rollback appear clean.
