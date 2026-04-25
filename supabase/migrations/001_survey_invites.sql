create table if not exists public.survey_invites (
  invite_token text primary key,
  participant_label text not null,
  group_code text not null,
  participant_name text not null default '',
  status text not null default 'not started' check (status in ('not started', 'in progress', 'submitted')),
  draft_payload jsonb not null default '{}'::jsonb,
  submitted_payload jsonb,
  updated_at timestamptz not null default now(),
  submitted_at timestamptz
);

insert into public.survey_invites (invite_token, participant_label, group_code)
values
  ('group-a-1', 'Group A Reviewer 1', 'A'),
  ('group-a-2', 'Group A Reviewer 2', 'A'),
  ('group-b-1', 'Group B Reviewer 1', 'B'),
  ('group-b-2', 'Group B Reviewer 2', 'B'),
  ('group-c-1', 'Group C Reviewer 1', 'C'),
  ('group-c-2', 'Group C Reviewer 2', 'C')
on conflict (invite_token) do nothing;
