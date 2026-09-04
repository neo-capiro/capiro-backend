-- PR D / LW-QA-013 — per-user LegiWatch display preferences.
-- One JSON doc per user (timezone / default view / default chamber).
-- Secondary DISPLAY only; never touches canonical hearing truth.
ALTER TABLE "users" ADD COLUMN "legiwatch_prefs" JSONB;
