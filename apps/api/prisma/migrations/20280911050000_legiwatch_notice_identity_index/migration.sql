-- Providers can cite the same qualified official notice even before a body
-- crosswalk is resolved. This is an identity lookup, never a title/name join.
CREATE INDEX hearing_observation_legislative_identity_idx
ON hearing_source_observation
((source_metadata #>> '{legislative,jurisdiction}'),
 (source_metadata #>> '{legislative,officialIdentity}'))
WHERE hearing_id IS NOT NULL;
