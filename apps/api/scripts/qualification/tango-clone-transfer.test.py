"""Pure guards by default; explicit --database-config runs isolated PostgreSQL fixtures.

The database fixture requires two empty, fully migrated loopback databases named
tango_transfer_source_test / tango_transfer_target_test. Root creates and owns them.
No fixture cleanup/reset is performed; retain them for inspection until root drops them.
"""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stdout
from uuid import uuid4

SCRIPT = Path(__file__).with_name("tango-clone-transfer.py")
spec = importlib.util.spec_from_file_location("funding_transfer", SCRIPT)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


def fixture_config():
    return {role: {"host":"127.0.0.1","port":5432,"dbname":"tango_transfer_"+role+"_test", "user":"fixture", "password_env":"TANGO_TRANSFER_TEST_PASSWORD", "sslrootcert":""} for role in ("source","target")}


class GuardTests(unittest.TestCase):
    def test_import_has_no_connection_side_effects(self):
        self.assertNotIn("psycopg", operator.__dict__)

    @patch.dict(os.environ,{"TANGO_TRANSFER_TEST_PASSWORD":"synthetic"})
    def test_synthetic_endpoints(self):
        operator.guard_config(fixture_config(),True)

    @patch.dict(os.environ,{"TANGO_TRANSFER_TEST_PASSWORD":"synthetic"})
    def test_synthetic_cannot_target_real_database(self):
        config = fixture_config(); config["target"]["dbname"]="capiro"
        with self.assertRaisesRegex(operator.Refusal,"synthetic_database_guard"):
            operator.guard_config(config,True)

    @patch.dict(os.environ,{"TANGO_TRANSFER_TEST_PASSWORD":"synthetic"})
    def test_synthetic_cannot_use_remote_host(self):
        config = fixture_config(); config["source"]["host"]="192.0.2.1"
        with self.assertRaisesRegex(operator.Refusal,"synthetic_host_guard"):
            operator.guard_config(config,True)

    @patch.dict(os.environ,{"TANGO_TRANSFER_TEST_PASSWORD":"synthetic"})
    @patch.object(Path,"is_file",return_value=True)
    def test_exact_source_and_clone_hosts(self,_):
        config = fixture_config()
        for role in config:
            config[role].update(host=operator.HOSTS[role],dbname="capiro",sslrootcert="fixture-ca")
        operator.guard_config(config)
        config["source"]["host"]="capiro-dev-other.cluster-csryw28ai752.us-east-1.rds.amazonaws.com"
        with self.assertRaisesRegex(operator.Refusal,"exact_environment_host_guard"):
            operator.guard_config(config)

    def test_missing_release_window_refuses_before_file_or_network(self):
        with redirect_stdout(io.StringIO()) as out:
            code=operator.main(["--config","absent-fixture.json"])
        self.assertEqual(code,2)
        self.assertIn("release_window_pause_and_snapshot_required",out.getvalue())

    def test_source_scope_excludes_private_vectors_and_decisions(self):
        self.assertIn("owner_user_id IS NULL",operator.SCOPES["context_embeddings"])
        self.assertIn("reviewed_by IS NULL",operator.SCOPES["tango_resource_link"])
        self.assertNotIn("sync_run",operator.TABLES)
        self.assertNotIn("tango_sync_checkpoint",operator.TABLES)
        self.assertNotIn("tango_procurement_forecast",operator.TABLES)

    def test_attachment_metadata_retains_hash_binding(self):
        value=operator.metadata("attachment",{"provider_data":{},"content_sha256":"a"*64,"text_truncated":True})
        self.assertEqual(value["attachmentContentSha256"],"a"*64)
        self.assertEqual(value["extractionMethod"],"local_parser")
        self.assertTrue(value["truncated"])


class SourceLifetimeTests(unittest.TestCase):
    def exercise(self, *, release_fails=False, stage_fails=False):
        events, staged = [], []
        released = False
        source, target = Mock(), Mock()
        response = Mock()
        response.fetchone.return_value = (0, 0, 0)

        def source_execute(sql, *_):
            nonlocal released
            if released:
                raise ConnectionError("source unavailable after release")
            if sql == "ROLLBACK":
                self.assertEqual(staged, list(operator.TABLES))
                events.append("source_release")
                if release_fails:
                    raise ConnectionError("source release failed")
                released = True
            return response

        def target_execute(sql, *_):
            if sql in ("COMMIT", "ROLLBACK"):
                events.append("target_" + sql.lower())
            return response

        def stage_one(_source, _target, table):
            self.assertFalse(released)
            if stage_fails and table == operator.TABLES[-1]:
                raise ConnectionError("staging failed")
            staged.append(table)
            events.append("staged_" + table)
            return [("id", "text")], {"source_rows": 0}

        def validate(_target):
            self.assertTrue(released, "target-only validation must not retain the source transaction")
            events.append("target_validation")

        source.execute.side_effect = source_execute
        target.execute.side_effect = target_execute
        publish = Mock(side_effect=lambda *_: events.append("publish") or {})
        with patch.multiple(operator, scalar=Mock(return_value=1), check_zero=Mock(),
                protected_digest=Mock(return_value={"unchanged": True}), stage=Mock(side_effect=stage_one),
                references=Mock(side_effect=validate), prepare_maps=Mock(), merge_table=Mock(),
                snapshots=Mock(), vectors=Mock(return_value={}), checksum=Mock(return_value="checksum"),
                publish=publish):
            try:
                outcome = operator.transfer(source, target, Path("unused"), commit=True)
            except ConnectionError as error:
                outcome = error
        return outcome, events, publish

    def test_complete_staging_releases_source_before_target_work_and_needs_no_later_source_access(self):
        result, events, publish = self.exercise()
        self.assertEqual(result["mode"], "commit")
        self.assertLess(events.index("staged_" + operator.TABLES[-1]), events.index("source_release"))
        self.assertLess(events.index("source_release"), events.index("target_validation"))
        self.assertLess(events.index("publish"), events.index("target_commit"))
        self.assertEqual(events.count("source_release"), 1)
        publish.assert_called_once()

    def test_failed_source_release_prevents_publication_and_target_commit(self):
        error, events, publish = self.exercise(release_fails=True)
        self.assertIsInstance(error, ConnectionError)
        self.assertEqual(str(error), "source release failed")
        self.assertNotIn("target_validation", events)
        self.assertNotIn("target_commit", events)
        publish.assert_not_called()

    def test_incomplete_staging_never_releases_source_or_publishes(self):
        error, events, publish = self.exercise(stage_fails=True)
        self.assertIsInstance(error, ConnectionError)
        self.assertEqual(str(error), "staging failed")
        self.assertNotIn("source_release", events)
        self.assertNotIn("target_commit", events)
        publish.assert_not_called()


def stable(value):
    return json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False)


def put_vector(conn, parent, source_type, source_table, body, url, chunker, metadata_extra=None, private=None):
    """Small ASCII fixture uses independently specified one-passage offsets."""
    base={"sourceTable":source_table,"sourceUrl":url,**(metadata_extra or {"binding":"government_record_id"})}
    doc_hash=hashlib.sha256(body.encode()).hexdigest()
    marker=hashlib.sha256(stable({"documentHash":doc_hash,"metadata":base,"model":"amazon.titan-embed-text-v2:0","chunker":chunker}).encode()).hexdigest()
    meta={**base,"parentId":str(parent),"documentHash":doc_hash,"chunkIndex":0,"start":0,"end":len(body),"offsetBasis":"plain_text_normalized_utf16","chunker":chunker}
    conn.execute("INSERT INTO context_embeddings(id,tenant_id,source_type,source_id,model,content_text,content_hash,embedding,metadata_jsonb,created_at,updated_at) VALUES(%s,%s,%s,%s,'amazon.titan-embed-text-v2:0',%s,%s,%s::vector,%s::jsonb,'2026-10-27','2026-10-27')",(uuid4(),private,source_type,str(parent)+":0",body,doc_hash,"["+",".join(["0.01"]*1024)+"]",json.dumps(meta)))
    if private is None:
        conn.execute(f"UPDATE {source_table} SET embedded_content_hash=%s,embedded_at='2026-10-27' WHERE id::text=%s",(marker,str(parent)))


def integration_tests(config,api_dir,node):
    import psycopg
    operator.guard_config(config,True)

    class DatabaseTests(unittest.TestCase):
        @classmethod
        def setUpClass(cls):
            cls.source_notice,cls.target_notice,cls.source_attachment,cls.target_attachment,cls.tenant,cls.client = [uuid4() for _ in range(6)]
            cls.notice_key=uuid4().hex
            cls.grant="999999900001"
            cls.url="https://sam.gov/api/prod/opps/v3/opportunities/resources/files/"+uuid4().hex+"/download"
            cls.source_text,cls.target_text=uuid4(),uuid4()
            cls.target_snapshot,cls.target_link,cls.target_history=uuid4(),uuid4(),uuid4()
            cls.hash="a"*64
            for role in ("source","target"):
                with operator.connect(psycopg,config[role],True) as conn:
                    conn.execute("SET app.bypass_rls='on'")
                    operator.require(operator.scalar(conn,"SELECT count(*) FROM federal_grant")==0,"fixture_requires_empty_catalog")
                    operator.require(operator.scalar(conn,"SELECT count(*) FROM sam_opportunity")==0,"fixture_requires_empty_catalog")
                    newer=role=="source"
                    stamp="2026-10-26" if newer else "2026-10-20"
                    notice=cls.source_notice if newer else cls.target_notice
                    attachment=cls.source_attachment if newer else cls.target_attachment
                    raw={"tango":{"payload":{"response_deadline":None},"providerUpdatedAt":stamp,"nested":{"source":True}}} if newer else {"tango":{"nested":{"retained":True}},"official":{"keep":"public evidence"}}
                    conn.execute("INSERT INTO federal_grant(id,title,agency,description,status,last_updated_at,synced_at,raw,close_date) VALUES(%s,'Grant','Agency',%s,'posted',%s,%s,%s::jsonb,%s)",(cls.grant,"Richer source description" if newer else "Older description",stamp,stamp,json.dumps({"tango":{"payload":{"important_dates":{"response_date":None}}}} if newer else {"retained":{"nested":"keep"}}),None if newer else "2027-01-01"))
                    conn.execute("INSERT INTO sam_opportunity(id,notice_id,title,notice_type,agency,description,source_url,last_synced_at,updated_at,raw_jsonb,response_deadline) VALUES(%s,%s,'Notice','Solicitation','Agency',%s,'https://sam.gov/opp/fixture/view',%s,%s,%s::jsonb,%s)",(notice,cls.notice_key if newer else str(__import__('uuid').UUID(cls.notice_key)).upper(),"Current public notice description" if newer else "Old public description",stamp,stamp,json.dumps(raw),None if newer else "2027-01-01"))
                    conn.execute("INSERT INTO opportunity_attachment(id,sam_opportunity_id,source_url,file_name,provider_attachment_id,provider_observed_at,status,content_sha256,archive_bucket,archive_key,observed_size_bytes,observed_mime_type,archived_at,updated_at) VALUES(%s,%s,%s,'document.pdf',%s,%s,'archived',%s,'private-public-archive',%s,42,'application/pdf',%s,%s)",(attachment,notice,cls.url+("?&token=" if newer else ""),"provider-document" if newer else None,stamp,cls.hash,"funding-source-documents/"+cls.hash,stamp,stamp))
                    conn.execute("INSERT INTO opportunity_document_text(id,attachment_id,attachment_content_sha256,status,extraction_method,text,char_count,truncated,fetched_at,updated_at) VALUES(%s,%s,%s,'available','local_parser',%s,%s,%s,%s,%s)",(cls.source_text if newer else cls.target_text,attachment,cls.hash,"Complete native extracted document text" if newer else "Partial old text",39 if newer else 16,not newer,stamp,stamp))
                    old_snapshot={"public":"old observation"}
                    conn.execute("INSERT INTO tango_resource_snapshot(id,resource_type,external_id,source_updated_at,provider_fetched_at,content_sha256,normalized_jsonb,active,version,superseded_at) VALUES(%s,'grant',%s,'2026-10-20','2026-10-20',%s,%s::jsonb,%s,1,%s)",(uuid4() if newer else cls.target_snapshot,cls.grant,hashlib.sha256(stable(old_snapshot).encode()).hexdigest(),json.dumps(old_snapshot),not newer,"2026-10-26" if newer else None))
                    if newer:
                        new_snapshot={"public":"new observation"}
                        conn.execute("INSERT INTO tango_resource_snapshot(id,resource_type,external_id,source_updated_at,provider_fetched_at,content_sha256,normalized_jsonb,active,version) VALUES(%s,'grant',%s,'2026-10-26','2026-10-26',%s,%s::jsonb,true,2)",(uuid4(),cls.grant,hashlib.sha256(stable(new_snapshot).encode()).hexdigest(),json.dumps(new_snapshot)))
                    conn.execute("INSERT INTO tango_resource_link(id,local_resource_type,local_resource_id,tango_resource_type,tango_external_id,basis,status,confidence_band,reviewed_by,reviewed_at,updated_at) VALUES(%s,'sam_opportunity',%s,'notice',%s,'exact_identifier',%s,'high',%s,%s,%s)",(uuid4() if newer else cls.target_link,str(notice),cls.notice_key,"active" if newer else "rejected",None if newer else uuid4(),None if newer else stamp,stamp))
                    history={"response_deadline":None if newer else "2027-01-01"}
                    history_body="Updated history body" if newer else "Old history body"
                    conn.execute("INSERT INTO tango_opportunity_notice(id,tango_notice_id,sam_opportunity_id,title,description,description_sha256,content_hash,snapshot,response_deadline,provider_updated_at,last_synced_at,updated_at) VALUES(%s,%s,%s,'Notice history',%s,%s,%s,%s::jsonb,%s,%s,%s,%s)",(uuid4() if newer else cls.target_history,cls.notice_key,notice,history_body,hashlib.sha256(history_body.encode()).hexdigest(),hashlib.sha256(stable(history).encode()).hexdigest(),json.dumps(history),None if newer else "2027-01-01",stamp,stamp,stamp))
                    if newer:
                        put_vector(conn,cls.grant,"funding_grant_chunk","federal_grant","Grant Agency Richer source description",None,"funding-v1-6000-400")
                        put_vector(conn,notice,"funding_notice_chunk","sam_opportunity","Notice Agency Current public notice description","https://sam.gov/opp/fixture/view","funding-v2-6000-400-unicode")
                        put_vector(conn,attachment,"funding_attachment_chunk","opportunity_attachment","document.pdf Complete native extracted document text",cls.url+"?&token=","funding-v3-6000chars-6000bytes-400-unicode",{"providerAttachmentId":"provider-document","binding":"archived_content_sha256","samOpportunityId":str(notice),"federalGrantId":None,"extractionStatus":"available","extractionMethod":"local_parser","attachmentContentSha256":cls.hash,"truncated":False,"documentRole":None})
                    conn.execute("INSERT INTO tenants(id,slug,name) VALUES(%s,%s,'Synthetic transfer tenant')",(cls.tenant,"transfer-"+role))
                    if newer:
                        # Excluded tenant-owned funding vector must never be staged or copied.
                        put_vector(conn,notice,"funding_notice_chunk","sam_opportunity","Private fixture text",None,"funding-v3-6000chars-6000bytes-400-unicode",private=cls.tenant)
                    else:
                        conn.execute("INSERT INTO clients(id,tenant_id,name) VALUES(%s,%s,'Synthetic saved client')",(cls.client,cls.tenant))
                        conn.execute("INSERT INTO client_funding_opportunity(id,tenant_id,client_id,source,sam_opportunity_id,workflow_status,evidence_source_type,user_created,notes,updated_at) VALUES(%s,%s,%s,'sam_gov',%s,'saved','user_action',true,'Preserve all saved fields','2026-10-20')",(uuid4(),cls.tenant,cls.client,notice))
            cls.saved=cls.query("target","SELECT row_to_json(t)::text FROM client_funding_opportunity t")

        @classmethod
        def query(cls,role,sql,params=None):
            with operator.connect(psycopg,config[role],True) as conn:
                conn.execute("SET app.bypass_rls='on'")
                cursor=conn.execute(sql,params)
                return cursor.fetchall() if cursor.description is not None else []

        def run_transfer(self,commit=False):
            with operator.connect(psycopg,config["source"],True) as source,operator.connect(psycopg,config["target"],True) as target:
                return operator.transfer(source,target,api_dir,node,commit)

        def test_01_dry_run_does_not_mutate_public_rows(self):
            before=self.query("target","SELECT md5(row_to_json(t)::text) FROM sam_opportunity t ORDER BY id")
            result=self.run_transfer()
            self.assertEqual(result["mode"],"dry_run")
            self.assertEqual(before,self.query("target","SELECT md5(row_to_json(t)::text) FROM sam_opportunity t ORDER BY id"))

        def test_02_commit_keeps_target_ids_saved_relationships_and_text(self):
            result=self.run_transfer(True)
            self.assertTrue(result["protected_rows_unchanged"])
            self.assertTrue(self.query("target","SELECT id=%s FROM sam_opportunity",(self.target_notice,))[0][0])
            self.assertTrue(self.query("target","SELECT id=%s AND sam_opportunity_id=%s FROM opportunity_attachment",(self.target_attachment,self.target_notice))[0][0])
            self.assertTrue(self.query("target","SELECT id=%s AND NOT truncated AND attachment_content_sha256=%s FROM opportunity_document_text",(self.target_text,self.hash))[0][0])
            self.assertEqual(self.saved,self.query("target","SELECT row_to_json(t)::text FROM client_funding_opportunity t"))
            self.assertTrue(self.query("target","SELECT raw_jsonb#>>'{tango,nested,retained}'='true' AND raw_jsonb#>>'{tango,nested,source}'='true' AND response_deadline IS NULL FROM sam_opportunity")[0][0])
            self.assertTrue(self.query("target","SELECT raw#>>'{retained,nested}'='keep' AND close_date IS NULL FROM federal_grant")[0][0])
            self.assertTrue(self.query("target","SELECT id=%s AND status='rejected' FROM tango_resource_link",(self.target_link,))[0][0])
            self.assertTrue(self.query("target","SELECT id=%s AND sam_opportunity_id=%s AND response_deadline IS NULL AND snapshot->'response_deadline'='null'::jsonb FROM tango_opportunity_notice",(self.target_history,self.target_notice))[0][0])
            self.assertEqual(self.query("target","SELECT count(*) FROM tango_resource_snapshot")[0][0],2)
            self.assertTrue(self.query("target","SELECT NOT active AND superseded_at IS NOT NULL FROM tango_resource_snapshot WHERE id=%s",(self.target_snapshot,))[0][0])
            self.assertTrue(self.query("target","SELECT version=2 AND normalized_jsonb->>'public'='new observation' FROM tango_resource_snapshot WHERE active")[0][0])

        def test_03_all_chunker_versions_and_remapped_markers(self):
            self.assertEqual(self.query("target","SELECT count(*) FROM context_embeddings WHERE tenant_id IS NULL")[0][0],3)
            self.assertEqual(self.query("target","SELECT count(*) FROM context_embeddings WHERE tenant_id IS NOT NULL")[0][0],0)
            self.assertEqual(self.query("target","SELECT count(*) FROM context_embeddings WHERE metadata_jsonb->>'chunker' LIKE 'funding-v1%'")[0][0],1)
            self.assertTrue(self.query("target","SELECT metadata_jsonb->>'samOpportunityId'=%s AND split_part(source_id,':',1)=%s FROM context_embeddings WHERE source_type='funding_attachment_chunk'",(str(self.target_notice),str(self.target_attachment)))[0][0])
            self.assertEqual(self.query("target","SELECT count(*) FROM opportunity_attachment WHERE embedded_at IS NOT NULL")[0][0],1)

        def test_04_repeat_is_idempotent(self):
            before=self.query("target","SELECT md5(row_to_json(t)::text) FROM context_embeddings t ORDER BY id")
            result=self.run_transfer(True)
            self.assertEqual(result["vectors"]["current_verified_documents"],3)
            self.assertEqual(before,self.query("target","SELECT md5(row_to_json(t)::text) FROM context_embeddings t ORDER BY id"))

        def test_05_identity_collision_fails_before_public_changes(self):
            extra=uuid4()
            self.query("target","INSERT INTO sam_opportunity(id,notice_id,title,notice_type,updated_at) VALUES(%s,%s,'Collision','Solicitation',now())",(extra,self.notice_key.upper()))
            try:
                with self.assertRaisesRegex(operator.Refusal,"duplicate_government_notice_identity"):
                    self.run_transfer(True)
                self.assertEqual(self.saved,self.query("target","SELECT row_to_json(t)::text FROM client_funding_opportunity t"))
            finally:
                self.query("target","DELETE FROM sam_opportunity WHERE id=%s",(extra,))

        def test_06_primary_key_collision_cannot_overwrite_other_identity(self):
            self.query("target","INSERT INTO sam_opportunity(id,notice_id,title,notice_type,updated_at) VALUES(%s,%s,'Other identity','Solicitation',now())",(self.source_notice,uuid4().hex))
            try:
                with self.assertRaisesRegex(operator.Refusal,"cross_identity_primary_key_collision"):
                    self.run_transfer(True)
            finally:
                self.query("target","DELETE FROM sam_opportunity WHERE id=%s",(self.source_notice,))

        def test_07_attachment_dual_key_collision_is_atomic(self):
            extra=uuid4()
            self.query("target","UPDATE opportunity_attachment SET source_url='https://example.gov/different.pdf' WHERE id=%s",(self.target_attachment,))
            self.query("target","INSERT INTO opportunity_attachment(id,sam_opportunity_id,source_url,updated_at) VALUES(%s,%s,%s,'2026-10-20')",(extra,self.target_notice,self.url))
            try:
                with self.assertRaisesRegex(operator.Refusal,"ambiguous_natural_identity"):
                    self.run_transfer(True)
                self.assertEqual(self.saved,self.query("target","SELECT row_to_json(t)::text FROM client_funding_opportunity t"))
            finally:
                self.query("target","DELETE FROM opportunity_attachment WHERE id=%s",(extra,))
                self.query("target","UPDATE opportunity_attachment SET source_url=%s WHERE id=%s",(self.url+"?&token=",self.target_attachment))

        def test_08_newer_target_body_and_historical_vectors_are_preserved(self):
            self.query("target","UPDATE sam_opportunity SET description='Newer target public description',raw_jsonb=jsonb_set(raw_jsonb,'{tango,providerUpdatedAt}','\"2026-10-28\"'::jsonb),last_synced_at='2026-10-28' WHERE id=%s",(self.target_notice,))
            before=self.query("target","SELECT content_hash FROM context_embeddings WHERE source_type='funding_notice_chunk'")
            result=self.run_transfer(True)
            self.assertGreater(result["vectors"]["source_body_conflicts"],0)
            self.assertTrue(self.query("target","SELECT description='Newer target public description' AND embedded_at IS NULL AND embedded_content_hash IS NULL FROM sam_opportunity")[0][0])
            self.assertEqual(before,self.query("target","SELECT content_hash FROM context_embeddings WHERE source_type='funding_notice_chunk'"))

        def test_09_existing_writer_lock_refuses(self):
            with operator.connect(psycopg,config["source"],True) as owner:
                owner.execute("SELECT pg_advisory_lock(hashtext('capiro:tango-funding'))")
                with self.assertRaisesRegex(operator.Refusal,"writer_lock_busy"):
                    self.run_transfer(True)
            self.assertEqual(self.saved,self.query("target","SELECT row_to_json(t)::text FROM client_funding_opportunity t"))

        def test_10_completed_empty_source_atomically_removes_obsolete_chunks(self):
            new_url="https://sam.gov/api/prod/opps/v3/opportunities/resources/files/"+uuid4().hex+"/download"
            with operator.connect(psycopg,config["source"],True) as conn:
                conn.execute("SET app.bypass_rls='on'")
                conn.execute("UPDATE opportunity_attachment SET source_url=%s,content_sha256=%s,archive_key=%s,provider_observed_at='2026-10-29' WHERE id=%s",(new_url,"c"*64,"funding-source-documents/"+"c"*64,self.source_attachment))
                conn.execute("UPDATE opportunity_document_text SET attachment_content_sha256=%s,status='not_provided',text=NULL,char_count=NULL,fetched_at='2026-10-29' WHERE id=%s",("c"*64,self.source_text))
                conn.execute("DELETE FROM context_embeddings WHERE source_type='funding_attachment_chunk'")
                put_vector(conn,self.source_attachment,"funding_attachment_chunk","opportunity_attachment","",new_url,"funding-v3-6000chars-6000bytes-400-unicode",{"providerAttachmentId":"provider-document","binding":"archived_content_sha256","samOpportunityId":str(self.source_notice),"federalGrantId":None,"extractionStatus":"available","extractionMethod":"local_parser","attachmentContentSha256":"c"*64,"truncated":False,"documentRole":None})
                correct_marker=conn.execute("SELECT embedded_content_hash FROM opportunity_attachment WHERE id=%s",(self.source_attachment,)).fetchone()[0]
                conn.execute("UPDATE opportunity_attachment SET embedded_content_hash=%s,embedded_at='2026-10-30' WHERE id=%s",("d"*64,self.source_attachment))
                conn.execute("DELETE FROM context_embeddings WHERE source_type='funding_attachment_chunk'")
            before=self.query("target","SELECT content_hash FROM context_embeddings WHERE source_type='funding_attachment_chunk'")
            invalid=self.run_transfer(True)
            self.assertGreater(invalid["vectors"]["unverified_empty_documents"],0)
            self.assertEqual(before,self.query("target","SELECT content_hash FROM context_embeddings WHERE source_type='funding_attachment_chunk'"))
            self.query("source","UPDATE opportunity_attachment SET embedded_content_hash=%s WHERE id=%s",(correct_marker,self.source_attachment))
            self.run_transfer(True)
            self.assertEqual(self.query("target","SELECT count(*) FROM context_embeddings WHERE source_type='funding_attachment_chunk'")[0][0],0)
            self.assertTrue(self.query("target","SELECT embedded_at IS NOT NULL AND embedded_content_hash IS NOT NULL FROM opportunity_attachment")[0][0])

        def test_11_explicit_demo_notices_are_excluded_and_target_preserved(self):
            source_fixture,target_fixture,saved,attachment,snapshot=[uuid4() for _ in range(5)]
            source_key="fixture-source-"+uuid4().hex
            for role,record,key in (("source",source_fixture,source_key),("target",target_fixture,"fixture-target-"+uuid4().hex)):
                self.query(role,"INSERT INTO sam_opportunity(id,notice_id,title,notice_type,raw_jsonb,updated_at) VALUES(%s,%s,'Explicit demo fixture','Solicitation','{\"fixture\":true}'::jsonb,'2026-10-20')",(record,key))
            self.query("target","INSERT INTO client_funding_opportunity(id,tenant_id,client_id,source,sam_opportunity_id,workflow_status,evidence_source_type,user_created,notes,updated_at) VALUES(%s,%s,%s,'sam_gov',%s,'saved','user_action',true,'Preserve demo reference','2026-10-20')",(saved,self.tenant,self.client,target_fixture))
            fixture_before=self.query("target","SELECT md5(row_to_json(t)::text) FROM sam_opportunity t WHERE id=%s",(target_fixture,))
            saved_before=self.query("target","SELECT md5(row_to_json(t)::text) FROM client_funding_opportunity t WHERE id=%s",(saved,))
            result=self.run_transfer(True)
            self.assertTrue(result["protected_rows_unchanged"])
            self.assertEqual(self.query("target","SELECT count(*) FROM sam_opportunity WHERE id=%s",(source_fixture,))[0][0],0)
            self.assertEqual(fixture_before,self.query("target","SELECT md5(row_to_json(t)::text) FROM sam_opportunity t WHERE id=%s",(target_fixture,)))
            self.assertEqual(saved_before,self.query("target","SELECT md5(row_to_json(t)::text) FROM client_funding_opportunity t WHERE id=%s",(saved,)))
            # Only the JSON boolean opts a row out. A string marker or an
            # unflagged malformed target remains a strict government-ID failure.
            for role,record,raw in (("source",source_fixture,'{"fixture":"true"}'),("target",target_fixture,'{"fixture":false}')):
                self.query(role,"UPDATE sam_opportunity SET raw_jsonb=%s::jsonb WHERE id=%s",(raw,record))
                try:
                    with self.assertRaisesRegex(operator.Refusal,"unverified_government_notice_identity"):
                        self.run_transfer(True)
                finally:
                    self.query(role,"UPDATE sam_opportunity SET raw_jsonb='{\"fixture\":true}'::jsonb WHERE id=%s",(record,))
            self.query("source","INSERT INTO opportunity_attachment(id,sam_opportunity_id,source_url,updated_at) VALUES(%s,%s,'https://example.gov/demo.pdf','2026-10-20')",(attachment,source_fixture))
            try:
                with self.assertRaisesRegex(operator.Refusal,"orphan_source_notice_reference"):
                    self.run_transfer(True)
            finally:
                self.query("source","DELETE FROM opportunity_attachment WHERE id=%s",(attachment,))
            self.query("source","INSERT INTO tango_resource_snapshot(id,resource_type,external_id,provider_fetched_at,content_sha256,normalized_jsonb) VALUES(%s,'notice',%s,'2026-10-20',%s,'{\"fixture\":true}'::jsonb)",(snapshot,source_key,hashlib.sha256(b'{"fixture":true}').hexdigest()))
            try:
                with self.assertRaisesRegex(operator.Refusal,"source_fixture_observation_dependency"):
                    self.run_transfer(True)
            finally:
                self.query("source","DELETE FROM tango_resource_snapshot WHERE id=%s",(snapshot,))

    return DatabaseTests


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--database-config",type=Path)
    parser.add_argument("--api-dir",type=Path,default=SCRIPT.resolve().parents[2])
    parser.add_argument("--node",default="node")
    args,remaining=parser.parse_known_args()
    if args.database_config:
        DatabaseTests=integration_tests(json.loads(args.database_config.read_text()),args.api_dir,args.node)
    unittest.main(argv=[sys.argv[0],*remaining])
