# Cadence — regulatory calendar

Cadence is the dashboard’s evidence-first view of regulatory deadlines and effective dates. It renders the automatically generated `data/calendar.json` / `data/calendar.ics` feed, so every visible date can be traced back to a detected change and its saved evidence.

## What it supports

- Evidence-linked dates generated from material ChangeSentinel findings.
- Month navigation, a daily agenda, source links and a direct route back to the underlying change.
- An `.ics` export and subscription feed for personal or team calendars.
- No Cadence email sign-in, magic link, or browser-side access to private team entries.
- Existing privately configured entries can still send their scheduled email reminders. Their owners and recipient addresses are never returned to the dashboard.

## Production setup

The evidence calendar works from the monitored repository data. The private reminder service is optional and must be set up separately before it can send email.

1. Apply `supabase/migrations/20261021180000_regulatory_calendar.sql` to the ChangeSentinel Supabase project (project ref `pysoukwmnwwgilkwafdy`) only if you need private recurring entries and email reminders. Using the Supabase CLI from the repository root: `supabase db push --project-ref pysoukwmnwwgilkwafdy`.
2. Add or manage private reminder entries through the secured back-office process. The dashboard intentionally does not expose a browser editor while email authentication is disabled.
   ```sql
   insert into public.regulatory_calendar_members (email, role, active)
   values ('calendar-admin@example.com', 'admin', true)
   on conflict (email) do update set role = excluded.role, active = true;
   ```
   Emails must be lowercase. The membership table is not readable or writable by anon/authenticated clients.
3. Deploy the function with JWT verification disabled at the gateway; it performs its own member verification for secured write requests and checks a separate high-entropy token for scheduled jobs:
   ```sh
   supabase functions deploy calendar-api --project-ref pysoukwmnwwgilkwafdy --no-verify-jwt
   ```
4. In Supabase Edge Function secrets, set:
   - `REGULATORY_CALENDAR_CRON_TOKEN`: a random value of at least 32 characters.
   - `RESEND_API_KEY`: the key for the Resend account used for email.
   - `REGULATORY_CALENDAR_FROM_EMAIL`: a sender address on a domain verified with Resend.
   - Optional `REGULATORY_CALENDAR_DASHBOARD_URL`: the deployed dashboard's Cadence URL.
5. In GitHub repository Settings → Secrets and variables → Actions, set these repository secrets:
   - `SUPABASE_PUBLISHABLE_KEY`: the project's publishable key (safe to use in the browser, but the workflow still reads it from a secret).
   - `REGULATORY_CALENDAR_CRON_TOKEN`: exactly the same random value as the Supabase Edge Function secret.
6. The `Cadence calendar reminders` workflow checks for reminders every day at 08:00 UTC. It can also be run manually. It checks the last seven days for missed reminder attempts, skips completed occurrences, and records successful sends so overlapping/retried runs do not send the same entry/occurrence/recipient twice. Failed sends are not marked delivered and can be retried by the next run if still within the catch-up window.

## Reminder behaviour

For a private entry scheduled on day D with a reminder lead time of N days, Cadence targets D − N. A zero-day lead time means a reminder on the scheduled day. A completed occurrence is not emailed. Emails contain the entry title, scheduled date, regulator/form, owner/notes and source link if provided.

## Important operational notes

- The Supabase database secret/service-role key must stay in Supabase Edge Function secrets. It must never be added to `index.html`, `dashboard.js` or the GitHub Pages data files.
- The existing automatic effective-date feed is not rewritten by team entries, and Scout plus other dashboard views remain independent.
