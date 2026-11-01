-- Review decisions recorded in the dashboard by a signed-in team member.
--
-- The decision is saved here at once, with the member's verified email, and the
-- Review Sync workflow copies it into data/reviews/ledger.json (the record the
-- engine, digests, precision and Ask Sentinel read). Rows are append-only: a
-- later decision is a new row, never an edit, and only synced_at / sync_note can
-- be set afterwards (by the sync). Access is only through the review-api
-- function with the service role; the public Data API cannot read or write it.
create table if not exists public.change_review_decisions (
  id uuid primary key default gen_random_uuid(),
  event_id text not null check (event_id ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('material', 'not_material', 'acknowledged', 'action_required')),
  rationale text not null default '' check (length(rationale) <= 600),
  owner text not null default '' check (length(owner) <= 600),
  ticket text not null default '' check (ticket = '' or (ticket ~* '^https?://\S+$' and length(ticket) <= 600)),
  event_type text not null default '' check (length(event_type) <= 40),
  url text not null default '' check (length(url) <= 2000),
  detected_at timestamptz,
  reviewed_by_email text not null check (reviewed_by_email = lower(btrim(reviewed_by_email)) and length(reviewed_by_email) between 3 and 320),
  reviewed_by_name text not null default '' check (length(reviewed_by_name) <= 120),
  reviewed_by_user uuid not null,
  reviewed_at timestamptz not null default now(),
  batch_id uuid not null default gen_random_uuid(),
  synced_at timestamptz,
  sync_note text not null default '' check (length(sync_note) <= 300),
  check (decision <> 'not_material' or length(btrim(rationale)) >= 10)
);
create index if not exists change_review_decisions_event_idx on public.change_review_decisions (event_id, reviewed_at desc);
create index if not exists change_review_decisions_unsynced_idx on public.change_review_decisions (reviewed_at) where synced_at is null;

-- What the ledger shows as "reviewed by". The email stays here (the repository
-- is public); a member without a display name is shown by the part before @.
alter table public.regulatory_calendar_members
  add column if not exists display_name text not null default '' check (length(display_name) <= 120);

create or replace function public.change_review_decisions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Review decisions are append-only; record a new decision instead.';
  end if;
  if (new.id, new.event_id, new.decision, new.rationale, new.owner, new.ticket, new.event_type, new.url, new.detected_at,
      new.reviewed_by_email, new.reviewed_by_name, new.reviewed_by_user, new.reviewed_at, new.batch_id)
     is distinct from
     (old.id, old.event_id, old.decision, old.rationale, old.owner, old.ticket, old.event_type, old.url, old.detected_at,
      old.reviewed_by_email, old.reviewed_by_name, old.reviewed_by_user, old.reviewed_at, old.batch_id) then
    raise exception 'Review decisions are append-only; only the sync status can change.';
  end if;
  return new;
end;
$$;
revoke all on function public.change_review_decisions_append_only() from public, anon, authenticated;

drop trigger if exists change_review_decisions_append_only on public.change_review_decisions;
create trigger change_review_decisions_append_only
  before update or delete on public.change_review_decisions
  for each row execute function public.change_review_decisions_append_only();

alter table public.change_review_decisions enable row level security;
revoke all on public.change_review_decisions from public, anon, authenticated;
grant select, insert, update on public.change_review_decisions to service_role;
