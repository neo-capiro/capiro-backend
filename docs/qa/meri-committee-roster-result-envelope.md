# Committee roster result envelope (dormant)

`envelopeCommitteeRosterResult` is an opt-in observer for successful legacy `get_committee_roster` calls. The normal schema, dispatcher, and model-facing response remain unchanged. The observer retains the legacy payload object and lets legacy rejections propagate unchanged.

The envelope records the federal or state local membership source and the filters the handler actually applies. State is the handler's trimmed, two-character uppercase prefix; chamber is any nonempty trimmed lowercase value. Neither is asserted to be a recognized state or chamber. `generatedAt` is response time and never becomes source freshness.

Successful resolutions describe returned local membership rows only. Federal membership-to-person joining can drop rows, and the local membership tables do not establish current seating. Completeness and matched count therefore remain unknown or partial; the observer never claims a full roster. Canonical federal committee and Bioguide IDs are required before recording provenance. Federal committee prefixes are also checked against the local ID convention (`h`/`house`, `s`/`senate`, `j`/`joint`), and role pointers must identify members in the returned list. State IDs have no canonical type here, so the observer records no state-member provenance; the state ranking-member field must remain null per the handler contract.

The legacy handler emits the same “No … committee matched” note for no-match and unresolved/ambiguous resolution. Since that note cannot distinguish absence from ambiguity, the observer treats it as unknown coverage and never returns `not_found_within_scope`. Missing required context is `needs_input` with the source marked `not_queried`.
