-- Proposed metadata read for the approved existing database owner. NOT EXECUTED.
-- Compare output to exact source SQL and historical/checksum aliases; absence is
-- a current catalog observation, never proof that a migration was never applied.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name, current_user AS database_role,
       current_schema() AS schema_name, current_setting('search_path') AS search_path,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) AS table_owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY n.nspname,c.relname LIMIT 30;

SELECT table_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default
FROM information_schema.columns
WHERE table_name IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY table_schema,table_name,ordinal_position LIMIT 100;

SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY n.nspname,c.relname,k.conname LIMIT 100;

SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
WHERE tablename IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY schemaname,tablename,indexname LIMIT 100;

SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
FROM pg_policies
WHERE tablename IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY schemaname,tablename,policyname LIMIT 100;

SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal
AND c.relname IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY n.nspname,c.relname,t.tgname LIMIT 100;

SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.proname IN ('portfolio_layout_order_valid','set_updated_at','rls_bypass','current_tenant_id','current_user_id')
ORDER BY n.nspname,p.proname,p.oid LIMIT 30;

SELECT n.nspname,c.relname,
       has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
       has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
       has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
       has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relname IN ('client_objectives','client_objective_revisions','user_portfolio_layouts')
ORDER BY n.nspname,c.relname LIMIT 30;
ROLLBACK;
