-- Research Portfolio federal/state bill tracking.
-- Bill membership uses the canonical legislative identities that already exist:
--   congress_bill.id  = "<congress>-<bill_type>-<bill_number>"   (federal)
--   state_bill.id     = "<state>-<sessionKey>-<billnumber>"      (state)
-- Adding the member kinds is what makes bills first-class portfolio subjects;
-- no parallel bill table, identity scheme or scheduler is introduced.
ALTER TYPE "research_portfolio_member_kind" ADD VALUE IF NOT EXISTS 'federal_bill';
ALTER TYPE "research_portfolio_member_kind" ADD VALUE IF NOT EXISTS 'state_bill';

-- Legislative material changes are recorded by the source ingestion owner, so the
-- event actor is the source rather than a user. User mutations keep actor_kind='user'.
ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'bill_changed';

-- Bills are review subjects, not only members. packages/shared defines
-- ResearchPortfolioReviewTargetKind as MemberKind | 'rule' | 'portfolio', so adding
-- the bill member kinds makes bills reviewable by type; the database enum must carry
-- them too or every bill-driven review insert fails the enum constraint.
ALTER TYPE "research_portfolio_review_target_kind" ADD VALUE IF NOT EXISTS 'federal_bill';
ALTER TYPE "research_portfolio_review_target_kind" ADD VALUE IF NOT EXISTS 'state_bill';
ALTER TABLE "research_portfolio_events" ADD COLUMN "actor_kind" VARCHAR(16) NOT NULL DEFAULT 'user';
ALTER TABLE "research_portfolio_events" ALTER COLUMN "actor_user_id" DROP NOT NULL;
