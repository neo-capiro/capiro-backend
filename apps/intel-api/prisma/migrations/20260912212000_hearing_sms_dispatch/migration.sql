ALTER TABLE intel_legiwatch_delivery_recipient DROP CONSTRAINT report_recipient_channel;
ALTER TABLE intel_legiwatch_delivery_recipient ADD CONSTRAINT report_recipient_channel CHECK(channel IN ('email','in_app','sms'));
CREATE FUNCTION hearing_sms_delivery_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel='sms' AND NOT EXISTS(SELECT 1 FROM intel_legiwatch_delivery d
    WHERE d.tenant_id=NEW.tenant_id AND d.id=NEW.delivery_id AND d.kind IN ('live_update','hearing_recap')) THEN
    RAISE EXCEPTION 'SMS requires a reviewed hearing publication delivery';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hearing_sms_delivery_kind BEFORE INSERT OR UPDATE ON intel_legiwatch_delivery_recipient
  FOR EACH ROW EXECUTE FUNCTION hearing_sms_delivery_kind();
