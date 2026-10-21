-- Cadence: team-owned regulatory calendar and idempotent reminder delivery ledger.
-- All access goes through calendar-api after checking a confirmed, non-anonymous
-- Supabase Auth user and active membership. The public Data API cannot access these tables.
create table if not exists public.regulatory_calendar_members (
  email text primary key check (email = lower(btrim(email)) and length(email) between 3 and 320),
  role text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  active boolean not null default true,
  added_at timestamptz not null default now()
);

create table if not exists public.regulatory_calendar_entries (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  description text not null default '' check (length(description) <= 4000),
  category text not null default 'expected_update'
    check (category in ('expected_update', 'deadline', 'meeting', 'internal_task', 'other')),
  start_date date not null,
  end_date date check (end_date is null or end_date >= start_date),
  regulator text not null default '' check (length(regulator) <= 160),
  source_url text check (source_url is null or source_url = '' or source_url ~* '^https?://'),
  owner_name text not null default '' check (length(owner_name) <= 120),
  recurrence text not null default 'none'
    check (recurrence in ('none', 'weekly', 'monthly', 'quarterly', 'yearly')),
  reminder_enabled boolean not null default false,
  reminder_days_before integer not null default 1 check (reminder_days_before between 0 and 90),
  reminder_emails text[] not null default '{}',
  completed_dates date[] not null default '{}',
  archived boolean not null default false,
  created_by uuid not null,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists regulatory_calendar_entries_active_start_idx
  on public.regulatory_calendar_entries (start_date) where archived = false;
create index if not exists regulatory_calendar_entries_reminders_idx
  on public.regulatory_calendar_entries (reminder_enabled, start_date) where archived = false;

create table if not exists public.regulatory_calendar_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.regulatory_calendar_entries(id) on delete cascade,
  occurrence_date date not null,
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email))),
  sent_at timestamptz not null default now(),
  provider_id text not null default '',
  unique (entry_id, occurrence_date, recipient_email)
);
create index if not exists regulatory_calendar_deliveries_sent_idx
  on public.regulatory_calendar_reminder_deliveries (sent_at desc);

alter table public.regulatory_calendar_members enable row level security;
alter table public.regulatory_calendar_entries enable row level security;
alter table public.regulatory_calendar_reminder_deliveries enable row level security;
revoke all on public.regulatory_calendar_members from public, anon, authenticated;
revoke all on public.regulatory_calendar_entries from public, anon, authenticated;
revoke all on public.regulatory_calendar_reminder_deliveries from public, anon, authenticated;
grant all on public.regulatory_calendar_members to service_role;
grant all on public.regulatory_calendar_entries to service_role;
grant all on public.regulatory_calendar_reminder_deliveries to service_role;
