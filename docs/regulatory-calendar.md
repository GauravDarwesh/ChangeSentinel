# Cadence — regulatory calendar

Cadence is a shared calendar for regulatory deadlines, expected releases, filing cycles, meetings and internal follow-ups. It is a separate feature from the automatically generated `data/calendar.json` / `data/calendar.ics` feed: automatic dates remain read-only evidence; private team entries live in Supabase.

## What it supports

- Manual team entries with a category, regulator/form, source link, owner and notes.
- One-off, weekly, monthly, quarterly and yearly recurrence. Monthly/quarterly dates stay anchored to the original day where possible (for example, a monthly series beginning on the 31st uses the last day of shorter months).
- Completion tracking for each occurrence of a repeating entry.
- Per-entry email reminders sent to one or more recipients, from the scheduled reminder service.
- A team-only edit surface. Only confirmed, non-anonymous Supabase Auth users whose email is active in `public.regulatory_calendar_members` can load or change team entries. An editor/admin can create or edit; viewer is read-only. The public Data API does not have table grants.

## Production setup

The code in this PR is not active just because it is merged. Apply the migration, deploy the Edge Function and configure the email provider before asking the team to use Cadence.

1. Apply `supabase/migrations/20261021180000_regulatory_calendar.sql` to the ChangeSentinel Supabase project (project ref `pysoukwmnwwgilkwafdy`). Using the Supabase CLI from the repository root: `supabase db push --project-ref pysoukwmnwwgilkwafdy`. Review the migration before applying it to any other environment.
2. Add the first calendar admin through the Supabase SQL Editor, replacing the sample address with the person's verified work email:
   ```sql
   insert into public.regulatory_calendar_members (email, role, active)
   values ('calendar-admin@example.com', 'admin', true)
   on conflict (email) do update set role = excluded.role, active = true;
   ```
   Add additional people as `editor` or `viewer`. Emails must be lowercase. The membership table is not readable or writable by anon/authenticated clients.
3. Deploy the function with JWT verification disabled at the gateway; the function performs its own email/member verification for browser requests and checks a separate high-entropy token for scheduled jobs:
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

For an entry scheduled on day D with a reminder lead time of N days, Cadence targets D − N. A zero-day lead time means a reminder on the scheduled day. A completed occurrence is not emailed. Emails contain the entry title, scheduled date, regulator/form, owner/notes and source link if provided. The “Test email” button sends a test to the currently signed-in team member.

## Important operational notes

- A Supabase admin must add team membership; an anonymous Ask Sentinel visitor session is not accepted for Cadence.
- The Supabase database secret/service-role key must stay in Supabase Edge Function secrets. It must never be added to `index.html`, `dashboard.js` or the GitHub Pages data files.
- If the user is signed in but sees “not on the Cadence team list”, confirm the exact lowercase email in `regulatory_calendar_members`.
- The existing automatic effective-date feed is not rewritten by team entries, and Scout plus other dashboard views remain independent.
