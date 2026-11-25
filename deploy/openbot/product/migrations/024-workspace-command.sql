-- Commit the exact command identity before any external workspace operation.
create table if not exists bp_phase_workspace_commands (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  tool_key text not null,
  argv_digest text not null,
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,occurrence_id),
  foreign key(project_id,run_id,occurrence_id,tool_key)
    references bp_phase_workspace_grants(project_id,run_id,occurrence_id,tool_key)
);
-- Older versions could dispatch after recording only the tool. Their exact
-- arguments are unknown, so permit reconciliation but never a new command.
insert into bp_phase_workspace_commands(project_id,run_id,occurrence_id,tool_key,argv_digest)
select project_id,run_id,occurrence_id,tool_key,'legacy-unverified' from bp_phase_workspace_grants
on conflict do nothing;
drop trigger if exists bp_phase_workspace_commands_immutable on bp_phase_workspace_commands;
create trigger bp_phase_workspace_commands_immutable before update or delete on bp_phase_workspace_commands
  for each row execute function bp_immutable_record();
