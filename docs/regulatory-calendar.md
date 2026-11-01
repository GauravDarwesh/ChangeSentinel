# Cadence — regulatory calendar

Cadence is the dashboard’s evidence-first view of regulatory deadlines and effective dates. It renders the automatically generated `data/calendar.json` / `data/calendar.ics` feed, so every visible date can be traced back to a detected change and its saved evidence.

## What it supports

- Evidence-linked dates generated from material ChangeSentinel findings.
- Month navigation, a daily agenda, source links and a direct route back to the underlying change.
- Shared search and entry-type filters across the month grid/agenda and Upcoming view.
- An Upcoming view grouping uncompleted overdue team commitments, today's entries, the next 7 days and later entries through the next 90 days. Recurring overdue entries show their most recent missed occurrence instead of flooding the list with every past cycle; selecting a date jumps back to that day in Month view.
- An `.ics` export and subscription feed for personal or team calendars.
- No email magic-link sign-in or self-service sign-up. Calendar editing uses password sign-in for pre-provisioned team accounts, with an in-dashboard password-reset flow that redirects to the deployed dashboard. Calendar list and mutation responses omit reminder recipient addresses; ordinary edits preserve the private server-side list unless recipients are explicitly replaced.
- Existing privately configured entries can still send their scheduled email reminders. Reminder recipient addresses stay on the server and are read by the scheduled sender; browser responses expose only whether reminders are configured. The entry owner/notes are shared team calendar fields, so members with calendar access can see those fields.

## Production setup

The evidence calendar works from the monitored repository data. The private reminder service is optional and must be set up separately before it can send email.

1. Apply `supabase/migrations/20261022040127_regulatory_calendar.sql` to the ChangeSentinel Supabase project (project ref `pysoukwmnwwgilkwafdy`) only if you need private recurring entries and email reminders. Using the Supabase CLI from the repository root: `supabase db push --project-ref pysoukwmnwwgilkwafdy`.
2. Provision each approved editor/viewer as a Supabase Auth user with a password using the trusted Supabase admin workflow, and add their normalized email to `regulatory_calendar_members` with the intended role. The dashboard has no self-service sign-up or magic-link login. Do not place an admin/service-role credential in the browser. Existing users created for the previous magic-link flow may need an administrator-assisted password setup/reset before they can use the editor. Manage entries through the authenticated Cadence editor; the API still checks active membership and role for each operation.
   ```sql
   insert into public.regulatory_calendar_members (email, role, active)
   values ('calendar-admin@example.com', 'admin', true)
   on conflict (email) do update set role = excluded.role, active = true;
   ```
   Emails must be lowercase. The membership table is not readable or writable by anon/authenticated clients.
3. In Supabase Project → Authentication → URL Configuration, set **Site URL** to `https://gauravdarwesh.github.io/ChangeSentinel/` and add `https://gauravdarwesh.github.io/ChangeSentinel/**` to **Redirect URLs**. The dashboard's password-reset request uses the deployed URL explicitly; Supabase requires that redirect to be allow-listed. Reset emails already sent with a localhost target remain stale, so request a fresh one after changing this setting.
4. Deploy the function with JWT verification disabled at the gateway; it performs its own member verification for secured write requests and checks a separate high-entropy token for scheduled jobs:
   ```sh
   supabase functions deploy calendar-api --project-ref pysoukwmnwwgilkwafdy --no-verify-jwt
   ```
5. In Supabase Edge Function secrets, set:
   - `REGULATORY_CALENDAR_CRON_TOKEN`: a random value of at least 32 characters.
   - `RESEND_API_KEY`: the key for the Resend account used for email.
   - `REGULATORY_CALENDAR_FROM_EMAIL`: a sender address on a domain verified with Resend.
   - Optional `REGULATORY_CALENDAR_DASHBOARD_URL`: the deployed dashboard's Cadence URL.
6. In GitHub repository Settings → Secrets and variables → Actions, set these repository secrets:
   - `SUPABASE_PUBLISHABLE_KEY`: the project's publishable key (safe to use in the browser, but the workflow still reads it from a secret).
   - `REGULATORY_CALENDAR_CRON_TOKEN`: exactly the same random value as the Supabase Edge Function secret.
7. The `Cadence calendar reminders` workflow checks for reminders every day at 08:00 UTC (13:30 India Standard Time). It can also be run manually. It checks the last seven days for missed reminder attempts, skips completed occurrences, and records successful sends. GitHub Actions concurrency serializes workflow runs, while the delivery table's unique constraint is a second guard against duplicate ledger rows. A provider send followed by a ledger-write failure can still result in a duplicate on retry; this is a provider/database boundary and should be monitored. Failed sends are not marked delivered and can be retried by the next run if still within the catch-up window. Reminder date calculations use UTC calendar days; treat this as an explicit operating convention unless the team later adds a configurable calendar timezone.

## Reminder behaviour

For a private entry scheduled on day D with a reminder lead time of N days, Cadence targets D − N. A zero-day lead time means a reminder on the scheduled day. A completed occurrence is not emailed. Emails contain the entry title, scheduled date, regulator/form, owner/notes and source link if provided.

## Important operational notes

- The Supabase database secret/service-role key must stay in Supabase Edge Function secrets. It must never be added to `index.html`, `dashboard.js` or the GitHub Pages data files.
- The existing automatic effective-date feed is not rewritten by team entries, and Scout plus other dashboard views remain independent.
