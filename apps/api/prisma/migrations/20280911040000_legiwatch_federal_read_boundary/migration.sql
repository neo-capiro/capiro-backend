-- Explicit public reference view for legacy federal SQL consumers. State
-- calendar readers continue using the canonical table with capability checks.
CREATE VIEW federal_committee_hearing WITH (security_invoker = true) AS
SELECT * FROM committee_hearing
WHERE geographic_jurisdiction = 'US' OR geographic_jurisdiction IS NULL;
GRANT SELECT ON federal_committee_hearing TO capiro_app;
