-- The original Ask Sentinel table capped each person's daily count at 3
-- (CHECK request_count <= 3). With the limit raised to 50 in
-- 20261027120000_ask_sentinel_agent.sql, every 4th question of the day failed
-- with "violates check constraint ask_sentinel_usage_request_count_check".
-- The limit is enforced by consume_ask_sentinel_turn; the column only needs
-- to stay non-negative.
alter table public.ask_sentinel_usage drop constraint if exists ask_sentinel_usage_request_count_check;
alter table public.ask_sentinel_usage add constraint ask_sentinel_usage_request_count_check check (request_count >= 0);
