# Phase 2 list_members result-envelope source slice

This source-only slice adds envelopeListMembersResult and a success-only observer for the existing list_members read. The observer is dormant: no API dispatch path, model response, or legacy handler is changed. It returns the exact legacy result object and propagates the original rejection; observer failures are suppressed.

The source observation is congress_member in capiro_local_database. The handler applies isCurrent=true and at least one recognized state or chamber filter, then runs a bounded query with a clamped limit from 1 to 100. The envelope records only recognized filters and reports provenance only for canonical Bioguide IDs. Returned rows must have a recognized canonical state name and a recognized house or senate chamber, even for a chamber-only query. Invalid state and missing usable filters are represented as needs_input with availability=not_queried, distinct resolution values, and unknown coverage.

Coverage describes only the filtered query against rows held in the local Capiro database. Fewer rows than the effective take limit supports a complete result for that local query; a result at the limit is partial because additional local matches may exist. A cap hit does not prove that rows were omitted. The handler does not select a synchronization timestamp or upstream version, so source freshness and completeness of the upstream federal roster remain unknown. The read has no client or tenant wall check because the CongressMember table is a global directory source with no client scope.

The advisory capability description now calls this the Capiro-held local roster and explicitly avoids implying upstream completeness or synchronization recency.

No Jest, typecheck, build, database, container, browser, provider, or live QA was run for this source slice under the active test hold. This is not package acceptance, dispatch exposure, or a release candidate.
