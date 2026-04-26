# Survey 698

This repo now supports a GitHub Pages frontend backed by Supabase.

## Architecture

- `docs/` is the static frontend you publish with GitHub Pages
- `docs/data/survey-data.json` is generated from:
  - `google_forms_creator.gs` for group assignment and code
  - `issue_briefs_reviewer_final.json` for participant-facing text
- `supabase/` contains the backend pieces:
  - a migration for the invite-state table
  - an Edge Function for load/save/submit

## Build the static survey data

```bash
npm run build
```

That regenerates `docs/data/survey-data.json`.

## GitHub Pages frontend setup

1. In GitHub, enable Pages from the `docs/` folder.
2. Copy `docs/app-config.example.js` to `docs/app-config.js`.
3. Fill in:
   - `supabaseUrl`
   - `supabaseAnonKey`
   - `functionName`
4. Commit `docs/app-config.js` if you want the public site to use that config.

Invite links will look like:

- `https://YOUR_GITHUB_PAGES_URL/#/invite/group-a-1`
- `https://YOUR_GITHUB_PAGES_URL/#/invite/group-a-2`

## Supabase backend setup

1. Create a Supabase project.
2. Run the SQL in [supabase/migrations/001_survey_invites.sql](/Users/moaj9/Code/WebappSurvey698/supabase/migrations/001_survey_invites.sql).
3. Deploy the Edge Function in [supabase/functions/survey-invite/index.ts](/Users/moaj9/Code/WebappSurvey698/supabase/functions/survey-invite/index.ts).
4. Make sure the function has access to:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

The backend stores one row per invite token with status:

- `not started`
- `in progress`
- `submitted`

Drafts autosave per invite link and can be resumed later from that same link.

## Viewing submitted results

The GitHub Pages app has a results page at:

```text
https://YOUR_GITHUB_PAGES_URL/#/results
```

It lists submitted invites and provides two CSV downloads:

- `survey-responses.csv`: one row per participant/test with the four ratings and comment
- `survey-submissions.csv`: one row per submitted invite with the raw submitted JSON payload

This page uses the Supabase Edge Function `results` action, so redeploy the Edge Function after changing `supabase/functions/survey-invite/index.ts`.

## Notes

- The frontend is static and GitHub Pages compatible.
- The backend state lives in Supabase, not in `survey.db`.
- `app.py` still exists locally, but it is no longer the deployment target for the GitHub Pages version.
