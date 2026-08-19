-- =============================================================================
-- 00016  schedule the pg_cron jobs
--
-- All cron scheduling for the platform, in one final migration, deliberately
-- LAST in the chain. It used to live inline in 00009 (six jobs) and 00013
-- (one job), which coupled two very different risks into one transaction:
-- the schema work (proven by execution against a production replica) and
-- CREATE EXTENSION pg_cron (which CANNOT be proven locally — the harness
-- Postgres has no pg_cron package, so the branch production would take was
-- dead code on every local run). Had CREATE EXTENSION failed in production
-- (extension not allow-listed for the migration role, not preloaded,
-- cron.database_name mismatch), it would have rolled back all of 00009
-- mid-chain. Isolated here, the worst case is "schema applied, jobs not
-- scheduled yet" — visible, recoverable, and nothing else lost.
--
-- Before applying to production: enable pg_cron in the dashboard
-- (Database -> Extensions) so the CREATE EXTENSION below is a no-op.
--
-- cron.schedule upserts by job name in current pg_cron versions, but that is
-- not assumed: each job is unscheduled by name first (ignoring "no such
-- job"), so this file is re-runnable and never stacks duplicate schedules.
--
-- The job COMMANDS have all been executed against the post-chain replica
-- schema and run clean — the only thing this file does that no local run
-- has ever done is the extension/scheduling half.
-- =============================================================================

DO $cron$
DECLARE
  v_job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    -- Re-runnable: clear any prior registration of our jobs by name.
    FOR v_job IN
      SELECT jobid, jobname FROM cron.job
       WHERE jobname IN ('video-stats-rollup', 'feed-dedupe-sweep',
                         'category-counts', 'feed-events-partitions',
                         'feed-events-retention', 'viewer-counters-prune',
                         'category-rate-medians')
    LOOP
      PERFORM cron.unschedule(v_job.jobid);
    END LOOP;

    -- From 00009: the stats rollup and its housekeeping.
    PERFORM cron.schedule('video-stats-rollup',      '* * * * *',
      $$SELECT public.rollup_video_stats()$$);
    PERFORM cron.schedule('feed-dedupe-sweep',       '*/5 * * * *',
      $$SELECT public.sweep_feed_event_dedupe()$$);
    PERFORM cron.schedule('category-counts',         '*/10 * * * *',
      $$SELECT public.refresh_category_counts()$$);
    PERFORM cron.schedule('feed-events-partitions',  '0 3 1 * *',
      $$SELECT public.ensure_feed_events_partitions(3)$$);
    PERFORM cron.schedule('feed-events-retention',   '30 3 1 * *',
      $$SELECT public.drop_old_feed_events_partitions(6)$$);
    PERFORM cron.schedule('viewer-counters-prune',   '0 4 * * 0',
      $$DELETE FROM public.viewer_video_counters
         WHERE last_event_at < now() - interval '180 days'$$);

    -- From 00013: hourly category medians, offset to :23 so the full-catalogue
    -- scan does not pile onto the top-of-hour jobs.
    PERFORM cron.schedule('category-rate-medians', '23 * * * *',
      $$SELECT public.refresh_category_rate_medians()$$);
  ELSE
    RAISE NOTICE 'pg_cron unavailable — jobs not scheduled (expected outside Supabase)';
  END IF;
END
$cron$;
