-- Least privilege beyond 0001 (docs/M4-REVIEW.md S11). On PostgreSQL 14 every role inherits from PUBLIC
-- CREATE on schema public and TEMPORARY on the database; sixkey_api needs neither (every query is
-- schema-qualified and nothing creates temporary tables). Privileges are additive, so the grants are
-- removed from PUBLIC itself (PostgreSQL 15 already ships without the first one).
-- M8: on Supabase check that no other role relies on these PUBLIC grants before applying.
-- Idempotent.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

-- Post-condition (re-review §5): a REVOKE run by a role that does not own the schema or the database
-- only WARNs ("no privileges could be revoked") and succeeds, so check the result itself. Raising here
-- rolls this whole file back (the runner applies each file in one transaction) and it is not recorded.
DO $$
BEGIN
  IF has_schema_privilege('sixkey_api', 'public', 'CREATE')
     OR has_database_privilege('sixkey_api', current_database(), 'TEMPORARY')
     OR has_database_privilege('sixkey_api', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'sixkey_api still has CREATE on schema public or TEMPORARY/CREATE on the database: run 0002 as the owner of both';
  END IF;
END
$$;
