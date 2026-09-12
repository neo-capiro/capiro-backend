ALTER TABLE intel_legiwatch_report_contact ADD COLUMN phone text CHECK(phone IS NULL OR phone ~ '^\+[1-9][0-9]{9,14}$');
ALTER TABLE intel_sms_verification ADD COLUMN contact_id text;
ALTER TABLE intel_hearing_sms_consent ADD COLUMN contact_id text;
ALTER TABLE intel_sms_verification ADD CONSTRAINT sms_verification_contact_scope FOREIGN KEY(tenant_id,contact_id) REFERENCES intel_legiwatch_report_contact(tenant_id,id);
ALTER TABLE intel_hearing_sms_consent ADD CONSTRAINT hearing_sms_contact_scope FOREIGN KEY(tenant_id,contact_id) REFERENCES intel_legiwatch_report_contact(tenant_id,id);
