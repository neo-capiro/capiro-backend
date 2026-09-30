CREATE TABLE IF NOT EXISTS capiro_qa_parent_verifications (
  task_id TEXT PRIMARY KEY,
  evidence_json TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  verified_utc TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS capiro_qa_review_before_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status NOT IN ('review', 'done')
BEGIN
  SELECT RAISE(ABORT, 'Capiro QA requires parent verification in Review before Done');
END;
CREATE TRIGGER IF NOT EXISTS capiro_qa_parent_verified_before_done
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'done' AND OLD.status != 'done'
  AND NOT EXISTS (SELECT 1 FROM capiro_qa_parent_verifications WHERE task_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Capiro QA requires an independent parent evidence record before Done');
END;
