-- Isolated candidate; migration identity requires owner allocation before integration.
-- Add vocabulary support only. Preserve every existing row and the legacy default.
ALTER TABLE "business_development_prospects"
  DROP CONSTRAINT "business_development_prospects_stage_check";
ALTER TABLE "business_development_prospects"
  ADD CONSTRAINT "business_development_prospects_stage_check"
  CHECK ("stage" IN (
    'researching', 'qualified', 'outreach', 'meeting', 'proposal', 'won', 'lost', 'parked',
    'identified', 'initiated', 'engaged', 'negotiation', 'closed_won', 'closed_lost'
  ));
