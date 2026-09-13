-- Public event refresh scope consumed by the existing canonical source owners.
CREATE TABLE legiwatch_event_record_watch (
 event_id TEXT PRIMARY KEY REFERENCES committee_hearing(id) ON DELETE CASCADE,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 days',attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','queued','review_required'))
);
GRANT SELECT,INSERT,UPDATE ON legiwatch_event_record_watch TO capiro_app;
REVOKE DELETE,TRUNCATE ON legiwatch_event_record_watch FROM capiro_app;
