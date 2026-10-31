-- PROPOSAL ONLY: DB owner must allocate a forward migration and verify/snapshot
-- the intended clone. This file is outside Prisma migration discovery.
-- Do not change the role's identity, attributes, memberships, or write privileges.
-- Historical grants for state_bill, federal_grant and sam_opportunity still need
-- actual-target verification; their source migration used conditional grants.
-- TRUST BOUNDARY: table-wide SELECT includes every underlying row and column.
-- Curated columns and public/canonical filters are enforced by the compiler,
-- NOT by these grants. See README for column-grant/view alternatives and the
-- DB-owner assessment required before adopting this proposal.
GRANT SELECT ON TABLE
  public.committee_hearing,
  public.committee_hearing_bill,
  public.legislative_agenda_item,
  public.state_bill_calendar_event
TO capiro_analytics_ro;

-- The agenda projections also require committee_hearing SELECT for their fixed
-- parent visibility/canonical-identity filter. No raw table name is user-selectable.
