# Committee-roster unresolved note accuracy (source only)

The federal and state `get_committee_roster` handlers return the same null-committee result when no local candidate matches and when a committee name matches more than one local candidate. The earlier model-facing note asserted “No ... committee matched” in both cases. This slice keeps the existing payload shape and query/authorization scope but changes that note to say no **unique** committee resolved within the requested filters and that the name may be absent or ambiguous. It asks for an exact ID/chamber and does not list candidate names or infer an upstream absence.

Focused specs were updated for true local no-match and ambiguous federal cases, and an ambiguous state case was added. These specs, typechecks, builds, database tests, and deployed QA were not run under the user's resource hold. The source change is isolated and does not constitute package acceptance.
