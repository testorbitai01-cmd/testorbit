-- Supabase exposes the `public` schema through its Data API (PostgREST) and, by default, grants the
-- `anon` and `authenticated` roles full access to every table created there. Test Orbit never uses
-- the Data API — all access goes through the Express API, connected as the table owner — so those
-- grants would only let anyone holding the project's (public) anon key read answer keys, student PII
-- and admin password hashes over https://<ref>.supabase.co/rest/v1. Revoke them, including for
-- tables created by future migrations. The app's own role is untouched. No-op on plain PostgreSQL.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
