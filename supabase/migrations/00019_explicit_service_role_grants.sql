-- =============================================================================
-- 00019 -- explicit service_role grants on every table and sequence in public
-- =============================================================================
--
-- WHY
-- ---
-- From 2026-10-30 Supabase stops auto-granting Data API privileges on NEW
-- tables in schema public. Tables that already exist keep the privileges they
-- were created with, so production is unaffected today. But every table this
-- repo's migrations create has, until now, got its service_role privileges
-- implicitly from Supabase's ALTER DEFAULT PRIVILEGES. Replaying the chain
-- after that date -- a new project, a preview branch, `supabase db reset`
-- locally -- would create every table with NO service_role privileges, and
-- every server route (src/lib/supabase-admin.ts) would fail with
--     ERROR:  permission denied for table ...
-- even though service_role bypasses RLS: BYPASSRLS skips row policies, it
-- does not stand in for table privileges.
--
-- WHAT THIS FILE DOES
-- -------------------
--   1. GRANT ALL on every table in public to service_role. "Table" here is
--      every relation GRANT ... ON TABLE accepts: ordinary and partitioned
--      tables (what pg_tables lists, including the feed_events_YYYY_MM
--      partitions and feed_events_default) plus views, materialized views and
--      foreign tables, so the explicit grants match the reach of the default
--      privileges in step 3. Extension-owned relations are skipped: their
--      privileges belong to the extension.
--   2. GRANT USAGE, SELECT, UPDATE on every sequence in public to service_role
--      (identity sequences included, e.g. processed_events' id, and the
--      shared feed_events_id_seq).
--   3. ALTER DEFAULT PRIVILEGES so tables and sequences created later in
--      public get the same service_role grants without anyone remembering.
--      Like every ALTER DEFAULT PRIVILEGES without FOR ROLE, this applies to
--      objects created BY THE ROLE RUNNING THIS MIGRATION (postgres on
--      Supabase). That includes the monthly feed_events partitions, which
--      create_feed_events_partition() makes from the pg_cron job scheduled
--      by 00016 -- pg_cron runs a job as the role that scheduled it.
--
-- Everything is a GRANT, so the file is idempotent: re-running it, or running
-- it on production where service_role already holds these privileges through
-- the old defaults, changes nothing.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
-- It grants NOTHING to anon or authenticated. Browser-role access in this
-- schema is narrow on purpose -- most tables are server-only, and 00006,
-- 00007, 00008, 00009 and 00013 REVOKE and then re-grant per column. 00008
-- also already ran
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES   FROM anon, authenticated;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
-- so every table created from 00008 on gets browser-role access only from an
-- explicit GRANT in its own migration. Those are unaffected by the platform
-- change and need nothing here.
--
-- OPEN DECISION FOR THE OWNER -- browser-role access that comes ONLY from
-- Supabase's defaults
-- ---------------------------------------------------------------------------
-- Four tables were created before 00008's default-privilege REVOKE and no
-- migration ever REVOKEs or GRANTs anon/authenticated privileges on them. In
-- production they carry ALL for anon and authenticated purely from the old
-- Supabase defaults (RLS decides which rows that reaches). On a replay after
-- 2026-10-30 they would carry nothing. Which of those two is right is a
-- product/security call, not something to settle as a side effect of a
-- grants migration:
--
--   * public.discount_codes   (00006 section 1)
--       RLS policy discount_codes_seller_all (auth.uid() = seller_id, FOR ALL).
--       LOAD-BEARING: src/app/api/discounts/route.ts reads, inserts and
--       updates this table with the cookie-auth client (createServerClient_,
--       role authenticated), not the admin client. On a post-2026-10-30
--       replay that route returns "Failed to load discount codes" until the
--       owner either adds explicit grants, e.g.
--           GRANT SELECT, INSERT, UPDATE (active) ON public.discount_codes TO authenticated;
--       or moves the route to the admin client. anon's privileges here are
--       unused (the policy's auth.uid() is NULL for anon) and could simply be
--       revoked.
--   * public.waitlist_entries (00006 section 2)
--       RLS policy waitlist_seller_read (FOR SELECT, auth.uid() = seller_id).
--       No code in src/ or ios/ reads it with a browser role today -- inserts
--       go through /api/waitlist and reads through /api/drops/[id]/restock,
--       both with the admin client -- so the default grants look unused.
--   * public.reports          (00006 section 3)
--       RLS on, zero policies: deny-all by design ("service role only:
--       reporters are anonymous, sellers must not see reports"). The default
--       grants are inert under RLS today; a REVOKE would make the intent
--       explicit.
--   * public.processed_events (00002)
--       RLS on, zero policies; only the webhook handlers touch it, with the
--       service role. Same as reports: inert grants, REVOKE would match intent.
--
-- See supabase/migrations/README.md: every migration that creates a table
-- must now carry its own explicit GRANTs.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO service_role;

DO $$
DECLARE
  r record;
BEGIN
  -- 1. Tables (plus views, materialized views, foreign tables).
  FOR r IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_catalog.pg_class'::regclass
                AND d.objid = c.oid
                AND d.deptype = 'e')
     ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', r.relname);
  END LOOP;

  -- 2. Sequences.
  FOR r IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'S'
       AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_depend d
              WHERE d.classid = 'pg_catalog.pg_class'::regclass
                AND d.objid = c.oid
                AND d.deptype = 'e')
     ORDER BY c.relname
  LOOP
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.%I TO service_role',
                   r.relname);
  END LOOP;
END
$$;

-- 3. Future objects created in public by the role running migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
