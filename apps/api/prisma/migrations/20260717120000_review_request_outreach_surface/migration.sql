-- Fix outreach hold persistence CHECK violation (Postgres 23514).
--
-- review_request was created (20260713050000) for the deliverable surfaces
-- alert-memo / district-brief / research. The later server-side outreach hold
-- (EngagementService.persistOutreachHold) reuses review_request with
-- surface='outreach', but that value was never added to review_request_surface_chk,
-- so every held outreach draft's INSERT failed with 23514 — the server-side send
-- gate silently never covered outreach (it fails open, logging "outreach hold
-- persistence FAILED"). Widen the allowed set to include 'outreach'.
--
-- Safe/additive: the new set is a superset of the old, so all existing rows still
-- satisfy it (validated instantly); only a brief lock on this small table.

ALTER TABLE "review_request" DROP CONSTRAINT IF EXISTS "review_request_surface_chk";

ALTER TABLE "review_request" ADD CONSTRAINT "review_request_surface_chk"
  CHECK ("surface" IN ('alert-memo', 'district-brief', 'research', 'outreach'));
