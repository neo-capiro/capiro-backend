ALTER TABLE intel_legiwatch_delivery DROP CONSTRAINT report_delivery_kind;
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK
 ((kind='bill_report' AND run_id IS NOT NULL) OR (kind IN ('bill_record','agenda','live_update','hearing_recap','record_brief','record_correction') AND run_id IS NULL));
CREATE OR REPLACE FUNCTION hearing_sms_delivery_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.channel='sms' AND NOT EXISTS(SELECT 1 FROM intel_legiwatch_delivery d WHERE d.tenant_id=NEW.tenant_id AND d.id=NEW.delivery_id
   AND d.kind IN ('live_update','hearing_recap','record_brief','record_correction')) THEN RAISE EXCEPTION 'SMS requires a reviewed hearing publication delivery'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE intel_sms_verification DROP CONSTRAINT intel_sms_verification_purpose_check;
ALTER TABLE intel_sms_verification ADD CONSTRAINT intel_sms_verification_purpose_check CHECK(purpose IN ('legacy_unbound','tracker_alerts','hearing_updates','hearing_records'));
ALTER TABLE intel_hearing_sms_consent DROP CONSTRAINT intel_hearing_sms_consent_purpose_check;
ALTER TABLE intel_hearing_sms_consent ADD CONSTRAINT intel_hearing_sms_consent_purpose_check CHECK(purpose IN ('hearing_updates','hearing_records'));
