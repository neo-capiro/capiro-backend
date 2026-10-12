-- SOURCE ONLY. Not executed. Saved revision identity/content must not be rewritten.
CREATE FUNCTION ws_preserve_saved_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'workspace saved version is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ws_doc_version_immutable BEFORE UPDATE ON ws_doc_version
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_saved_version();
-- Existing delete/cascade semantics remain. A deleted source cannot be restaged.
