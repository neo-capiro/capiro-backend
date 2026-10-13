# Proposed runtime permissions — review only

No credential, role, grant, policy, network or deployment change has been executed. An approved read-only database identity does not currently follow from this source packet. The preview refuses the ordinary writer connection. Existing production Clerk references are authority metadata only; issuer/key pairing must be confirmed by the runtime owner without revealing secret contents.

| Input / permission | Exact required scope |
| --- | --- |
| entrypoint | `apps/api/dist/src/preview-readonly/preview-main.js`, isolated module only |
| opt-in | `CAPIRO_PREVIEW_READONLY=true`; missing/wrong value refuses startup |
| connection | explicit `PREVIEW_READONLY_DATABASE_URL`, PostgreSQL only, separate approved read identity; no DATABASE_URL fallback |
| org scope | approved existing internal `PREVIEW_TENANT_ID` UUID + exact `PREVIEW_CLERK_ORG_ID`; DB tenant slug must be `capiro-internal` |
| Clerk | existing production `CLERK_SECRET_KEY`, exact HTTPS `CLERK_JWT_ISSUER`; canonical JWT verification/JWKS and two active-session GETs per read; no create/update/list/provision route |
| DB | CONNECT to the approved existing application database; USAGE on existing schema; SELECT columns below; no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, table/schema ownership, inherited writer/owner role, superuser/BYPASSRLS/CREATEROLE/CREATEDB |
| default DB posture | role or reviewed connection sets `default_transaction_read_only=on`; source also sets each transaction read-only and rejects unsafe effective table privileges |
| users | SELECT `id, clerk_user_id, email, first_name, last_name, title, email_signature_html, email_signature_enabled, tour_completed_at, legiwatch_intro_seen_at, legiwatch_prefs` |
| tenant_memberships | SELECT `id, tenant_id, user_id, role, status, updated_at, billing_admin` |
| tenants | SELECT `id, slug, status, clerk_org_id, name, settings, plan_tier` |
| clients | SELECT existing canonical Client scalar projection (all scalar columns); explicit tenant predicates retained on list/detail |
| policy functions | existing `current_tenant_id()` and `rls_bypass()` invoker helpers required by current RLS; no SECURITY DEFINER write-capable function permission is justified |
| sequences | none |
| secret delivery | existing approved runtime owner path scoped to the read-only DB input and existing Clerk key; no unrelated provider/AI/S3 secret or permission |
| outbound | existing approved DB + Clerk verification/session read paths only; no new network rule authored/applied |
| AWS task actions | none performed or granted here; any task execution secret access and KMS scope require separate exact owner review |
| S3/SES/SNS/models/OAuth/webhooks/jobs | none |

Database owners must review effective PUBLIC/inherited privileges and writable security-definer functions, relation ownership and schema CREATE privileges. Merely naming a role read-only is insufficient. The source privilege query checks the effective current role across non-system relations and requires default read-only; native acceptance must separately prove actual column grants, RLS visibility and denied DML with the approved identity. Do not use the capiro_app writer or capiro_master owner membership.

Native acceptance must prove first-statement read-only behavior, failure to write identity/business/audit tables, existing tenant RLS and explicit same-tenant filters, no cross-request GUC leakage, fresh membership revocation, role refusal, commit refusal, and complete bootstrap without workers. Run only after separate approval; this source task executed none of it. No grant SQL is executable from this packet, and no new DB role has been created.

Neo's existing preview policy removes approved preview test data after 14 days. This read path creates no test data. Any later irreversible deletion still requires action-time confirmation and must not delete production business records merely because the preview read them.
