-- Fortnite Creator Analytics - Supabase (Postgres) schema.
--
-- Mirrors the data model that used to live entirely in src/store.js's
-- in-memory Maps + local JSONL files (see that file's header comment for the
-- original layout). The crawler (running as a long-lived process outside
-- Vercel) writes here; Vercel's serverless API reads from here.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query) before running scripts/migrate-to-supabase.js.

create table if not exists islands (
  code                   text primary key,
  title                  text,
  creator_code           text,
  category               text,
  created_in             text,
  tags                   text[] not null default '{}',
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  last_metrics_polled_at timestamptz,
  poll_attempts          int not null default 0
);

-- create table ... if not exists doesn't add columns to an already-existing
-- table, so this covers databases that ran an earlier version of this file.
-- Fast/non-blocking in Postgres 11+ (a constant default doesn't rewrite the
-- table).
alter table islands add column if not exists poll_attempts int not null default 0;

create index if not exists islands_creator_code_idx on islands (creator_code);
create index if not exists islands_tags_idx on islands using gin (tags);
create index if not exists islands_last_metrics_polled_at_idx on islands (last_metrics_polled_at);

-- One row per metrics reading. (code, captured_at) is unique because
-- addSnapshot()'s dedup rule is "skip if the most recent stored snapshot has
-- the same capturedAt" - Epic's API only ever exposes a single "current"
-- reading, so without this the crawler would write near-duplicate rows every
-- cycle forever.
create table if not exists snapshots (
  id                        bigserial primary key,
  code                      text not null references islands (code) on delete cascade,
  captured_at               timestamptz not null,
  peak_ccu                  double precision,
  unique_players             double precision,
  minutes_played             double precision,
  average_minutes_per_player double precision,
  plays                     double precision,
  favorites                 double precision,
  recommendations           double precision,
  retention_d1              double precision,
  retention_d7              double precision,
  unique (code, captured_at)
);

-- Powers getHistory() (all snapshots for one island, ascending) and the
-- "latest snapshot per island" lookups used by leaderboard/movers/browse.
create index if not exists snapshots_code_captured_at_idx on snapshots (code, captured_at desc);
create index if not exists snapshots_captured_at_idx on snapshots (captured_at);

-- Singleton row (id always 1) - cursor + counters for catalog-discovery
-- pagination, so successive crawl cycles resume instead of re-scanning the
-- same first page every time.
create table if not exists crawl_state (
  id                      int primary key default 1 check (id = 1),
  cursor                  text,
  cycles_completed        int not null default 0,
  last_crawl_started_at   timestamptz,
  last_crawl_finished_at  timestamptz
);

insert into crawl_state (id) values (1) on conflict (id) do nothing;

-- Bounded log of recent crawl-cycle summaries (kept to the last 50 by the
-- application layer, same as the old crawl-log.json).
create table if not exists crawl_log (
  id            bigserial primary key,
  reason        text,
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   bigint,
  catalog_pages_fetched   int,
  new_islands_discovered  int,
  metrics_polled          int,
  metrics_written         int,
  metrics_not_found       int,
  error_count             int,
  fatal                   boolean not null default false,
  sample_errors           jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists crawl_log_created_at_idx on crawl_log (created_at desc);

-- User watchlists ("My Islands"). Each row ties a signed-in user (Supabase
-- Auth) to an island they want to track. The browser reads/writes this table
-- directly via the anon key + RLS below - no server code involved, which is
-- the idiomatic Supabase pattern for per-user data. auth.users is managed by
-- Supabase Auth; on delete cascade cleans up if a user is removed.
create table if not exists user_watchlist (
  user_id     uuid not null references auth.users (id) on delete cascade,
  code        text not null references islands (code) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, code)
);

create index if not exists user_watchlist_user_idx on user_watchlist (user_id);

alter table user_watchlist enable row level security;

-- A user can see and modify ONLY their own watchlist rows. auth.uid() is the
-- id of the currently authenticated user (null for anon), so these policies
-- deny everything to logged-out callers and cross-user access alike.
drop policy if exists "own watchlist select" on user_watchlist;
create policy "own watchlist select" on user_watchlist for select using (auth.uid() = user_id);
drop policy if exists "own watchlist insert" on user_watchlist;
create policy "own watchlist insert" on user_watchlist for insert with check (auth.uid() = user_id);
drop policy if exists "own watchlist delete" on user_watchlist;
create policy "own watchlist delete" on user_watchlist for delete using (auth.uid() = user_id);

grant select, insert, delete on user_watchlist to authenticated;
-- service_role bypasses RLS and isn't used for this table by app code, but
-- grant it too so admin/debug scripts can inspect watchlists if needed.
grant all on user_watchlist to service_role;

-- Row Level Security: this project has no end-user auth, and all writes come
-- from the crawler using the service_role key (which bypasses RLS entirely).
-- Enable RLS with a read-only policy for the anon/public key so the tables
-- aren't openly writable if the anon key is ever exposed client-side.
alter table islands enable row level security;
alter table snapshots enable row level security;
alter table crawl_state enable row level security;
alter table crawl_log enable row level security;

drop policy if exists "public read islands" on islands;
create policy "public read islands" on islands for select using (true);

drop policy if exists "public read snapshots" on snapshots;
create policy "public read snapshots" on snapshots for select using (true);

drop policy if exists "public read crawl_state" on crawl_state;
create policy "public read crawl_state" on crawl_state for select using (true);

drop policy if exists "public read crawl_log" on crawl_log;
create policy "public read crawl_log" on crawl_log for select using (true);

-- Table-level grants. RLS policies above only take effect once a role
-- already has the underlying SQL privilege - some Supabase projects don't
-- auto-grant that to new tables, which surfaces as a flat "permission denied
-- for table X" (Postgres error 42501) even though the policies look right.
-- service_role bypasses RLS but still needs the grant to touch the table at
-- all; anon/authenticated get read-only, matching the policies above.
grant select on islands, snapshots, crawl_state, crawl_log to anon, authenticated;
grant all on islands, snapshots, crawl_state, crawl_log to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Read-side views for the Vercel-hosted dashboard API (src/supabaseStore.js).
-- These replace the in-memory aggregation src/store.js used to do over its
-- own Maps - equivalent logic, just pushed into Postgres so a serverless
-- function never has to pull the whole catalog into memory to rank it.

-- One row per island: its most recent snapshot, and (rn=2) the one before
-- that, which getMovers needs to compute a delta. A single window-function
-- pass over snapshots, partitioned per island.
create or replace view ranked_snapshots as
select s.*, row_number() over (partition by code order by captured_at desc) as rn
from snapshots s;

create or replace view latest_snapshots as
select * from ranked_snapshots where rn = 1;

create or replace view prior_snapshots as
select * from ranked_snapshots where rn = 2;

-- Flat island + latest-snapshot join, used by leaderboard/search/browse -
-- everything PostgREST can filter/sort/paginate directly since there's no
-- nesting.
create or replace view islands_with_latest as
select
  i.code, i.title, i.creator_code, i.category, i.created_in, i.tags,
  i.first_seen_at, i.last_seen_at, i.last_metrics_polled_at,
  ls.captured_at, ls.peak_ccu, ls.unique_players, ls.minutes_played,
  ls.average_minutes_per_player, ls.plays, ls.favorites, ls.recommendations,
  ls.retention_d1, ls.retention_d7
from islands i
left join latest_snapshots ls on ls.code = i.code;

-- islands + both latest and prior snapshot, for getMovers. Only islands with
-- at least 2 readings show up here (inner join on prior_snapshots).
create or replace view islands_with_movement as
select
  i.code, i.title, i.creator_code, i.category, i.created_in, i.tags,
  i.first_seen_at, i.last_seen_at,
  ls.captured_at as latest_captured_at, ls.peak_ccu as latest_peak_ccu,
  ls.unique_players as latest_unique_players, ls.minutes_played as latest_minutes_played,
  ls.average_minutes_per_player as latest_average_minutes_per_player, ls.plays as latest_plays,
  ls.favorites as latest_favorites, ls.recommendations as latest_recommendations,
  ls.retention_d1 as latest_retention_d1, ls.retention_d7 as latest_retention_d7,
  ps.captured_at as prior_captured_at, ps.peak_ccu as prior_peak_ccu,
  ps.unique_players as prior_unique_players, ps.minutes_played as prior_minutes_played,
  ps.average_minutes_per_player as prior_average_minutes_per_player, ps.plays as prior_plays,
  ps.favorites as prior_favorites, ps.recommendations as prior_recommendations,
  ps.retention_d1 as prior_retention_d1, ps.retention_d7 as prior_retention_d7
from islands i
join latest_snapshots ls on ls.code = i.code
join prior_snapshots ps on ps.code = i.code;

-- Per-creator rollup. bestIsland is resolved separately in supabaseStore.js
-- (one extra query for the page of creators actually being returned) rather
-- than here, to keep this view a plain GROUP BY.
create or replace view creator_stats as
select
  coalesce(i.creator_code, '(unknown)') as creator_code,
  count(*) as island_count,
  count(ls.code) as islands_with_data,
  coalesce(sum(ls.peak_ccu), 0) as total_peak_ccu,
  coalesce(sum(ls.unique_players), 0) as total_unique_players
from islands i
left join latest_snapshots ls on ls.code = i.code
group by coalesce(i.creator_code, '(unknown)');

-- Per-creator best island (highest peakCCU), for getCreatorLeaderboard's
-- bestIsland field. distinct on (creator_code) ordered by peak_ccu desc picks
-- exactly one row per creator - their top island.
create or replace view creator_best_island as
select distinct on (coalesce(i.creator_code, '(unknown)'))
  coalesce(i.creator_code, '(unknown)') as creator_code,
  i.code, i.title, ls.peak_ccu
from islands i
join latest_snapshots ls on ls.code = i.code
order by coalesce(i.creator_code, '(unknown)'), ls.peak_ccu desc nulls last;

-- Tag frequency across the whole discovered catalog (unnest requires a real
-- query, not something PostgREST's filter syntax can express).
create or replace view tag_counts as
select tag, count(*) as count
from islands, unnest(tags) as tag
group by tag
order by count desc;

-- Daily snapshot counts (the crawler's own coverage growth over time).
create or replace view snapshot_daily_counts as
select (captured_at at time zone 'utc')::date as date, count(*) as new_snapshots
from snapshots
group by 1
order by 1;

grant select on ranked_snapshots, latest_snapshots, prior_snapshots, islands_with_latest,
  islands_with_movement, creator_stats, creator_best_island, tag_counts, snapshot_daily_counts
  to anon, authenticated, service_role;
