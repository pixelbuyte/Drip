# Migrations

Files here are applied in version order (`00001_…`, `00002_…`, …). The
`_abandoned_fork/` directory is outside that order on purpose and must never
be applied; see its own README.

## Every new table carries its own explicit GRANTs

From 2026-10-30 Supabase no longer auto-grants Data API privileges on new
tables in schema `public`, and since `00008` this schema's default privileges
already withhold everything from `anon` and `authenticated`. So any migration
that creates a table (or view, or sequence) in `public` must grant, in the
same file, exactly what each role needs: `GRANT ALL ON public.<table> TO
service_role;` (plus `USAGE, SELECT, UPDATE` on any sequence it owns), and
then whatever narrow, usually column-level, `anon`/`authenticated` grants the
browser roles need, with nothing for them when the table is server-only. Do
not rely on defaults. `00019_explicit_service_role_grants.sql` backfills
`service_role` grants for everything that existed before this rule and adds a
`service_role` default privilege as a safety net, but that safety net only
covers objects created by the role that runs migrations, and it never covers
`anon` or `authenticated`.
