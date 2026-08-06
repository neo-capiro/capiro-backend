# Memory Review UX Phase 2 — Next Increment

Close the revision persistence and compatibility gate before beginning notifications or the Review Inbox redesign.

Required outcomes:

1. Reconcile the four lineage columns with Prisma ownership on a complete checkout:
   - `revision_root_id`
   - `predecessor_candidate_id`
   - `revision_number`
   - `superseded_by_id`
2. Pass Prisma validate and generate without schema drift.
3. Replay both Phase 2 migrations on:
   - a clean PostgreSQL database;
   - an upgrade database containing existing pending and changes-requested candidates.
4. Run real concurrent transactions proving exactly one successor can be created.
5. Run real-role RLS tests for:
   - original proposer;
   - assigned reviewer;
   - unauthorized tenant member;
   - walled administrator;
   - cross-tenant user.
6. Verify older candidate/version decision routes cannot bypass:
   - named assignment;
   - revision lineage;
   - predecessor supersession;
   - successor authorization.
7. Add permanent executable closeout evidence for all of the above.

Do not begin notification delivery or frontend inbox work until this compatibility increment passes.
