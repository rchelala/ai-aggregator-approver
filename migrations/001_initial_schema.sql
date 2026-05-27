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

create table if not exists api_logs (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  provider text not null,
  model text not null,
  agent_type text not null,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  cost_usd numeric(10, 6),
  duration_ms integer,
  post_id uuid references posts(id),
  error text
);
