-- Migration 0001: initial schema.
-- Apply to a fresh Neon database with: psql "$DATABASE_URL" -f db/migrations/0001_init.sql

create extension if not exists "pgcrypto";

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  topic text not null,
  research_summary text,
  draft_variants jsonb,
  selected_variant text,
  bullet_breakdown jsonb,
  engagement_metrics jsonb,
  posted boolean not null default false,
  posted_at timestamptz,
  tweet_id text,
  status text not null default 'queued',
  reason text,
  slack_message_ts text
);

create index if not exists posts_created_at_idx on posts(created_at desc);
create index if not exists posts_status_idx on posts(status);
create index if not exists posts_posted_at_idx on posts(posted_at desc) where posted = true;

create table if not exists topics (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  priority int not null default 5,
  last_used_at timestamptz,
  active boolean not null default true
);

create table if not exists api_logs (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  provider text not null,
  model text not null,
  agent_type text not null,
  input_tokens int,
  cached_input_tokens int,
  output_tokens int,
  cost_usd numeric(10,6),
  duration_ms int,
  post_id uuid references posts(id) on delete set null,
  error text
);

create index if not exists api_logs_timestamp_idx on api_logs(timestamp desc);
create index if not exists api_logs_post_id_idx on api_logs(post_id);
create index if not exists api_logs_provider_idx on api_logs(provider);
