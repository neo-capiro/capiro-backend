# Physical column names for the reviewed reader

The frozen PR2 permission proposal listed the Prisma tenant field `settings` as a SQL column. The exact Core schema maps it to `settings_jsonb`. Use the physical names below for any separate runtime-owner grant review; no grant was executed. The API's actual Prisma query already resolves the mapping correctly, and no product code changes are required.

| Table | Physical SELECT columns |
| --- | --- |
| users | id, clerk_user_id, email, first_name, last_name, title, email_signature_html, email_signature_enabled, tour_completed_at, legiwatch_intro_seen_at, legiwatch_prefs |
| tenants | id, slug, status, clerk_org_id, name, **settings_jsonb**, plan_tier |
| tenant_memberships | id, tenant_id, user_id, role, status, updated_at, billing_admin |
| clients | canonical Client scalar projection, 35 current physical columns, enumerated in the unexecuted fixture-schema.sql SELECT clause |

Those clients columns are: id, tenant_id, name, website, description, product_description, primary_contact_name, primary_contact_email, primary_contact_phone, logo_s3_key, logo_content_type, logo_uploaded_at, intake_data_jsonb, status, sector_tag, profile_type, profile_status, submission_tracks, issue_codes, uei, cage_code, naics_codes, psc_codes, tango_entity_last_synced_at, tango_entity_last_attempt_at, tango_entity_last_error, applicant_types, set_aside_certifications, lda_client_ids, memory_wall, created_by_user_id, created_at, updated_at, account_owner_version, canonical_entity_id.

All other PR2 runtime boundaries remain: explicit separate approved reader connection; existing pinned internal tenant/org and production Clerk issuer/key pair; no writer/owner inheritance, superuser/BYPASSRLS/CREATEROLE/CREATEDB, DML/column-writer/sequence privileges, unrelated provider/S3/model credentials or jobs. The catalog-only local capiro_app observation is not acceptance of any production login or grant. The unexecuted fixture SQL names an existing local test role and is not a production grant script.
