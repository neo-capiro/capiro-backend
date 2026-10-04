# Controlled-read execution accounting

The existing local operator now durably records execution intent before its single native call. A missing or invalid outcome after intent reports an unknown submission count; observed native zero or one is preserved before writing the final spend checkpoint. This prevents a thrown call or checkpoint failure from being mislabeled as zero submissions.

The retained red reproduction has12 passing and5 failing tests; the repaired boundary passes17/17. Both syntax checks and scoped diff checks pass. [Independent review](independent-review.json) binds the frozen source and evidence. No backend, budget, reservation, settlement, retry, authentication or fixture authority changed. No live capture ran during this qualification.
