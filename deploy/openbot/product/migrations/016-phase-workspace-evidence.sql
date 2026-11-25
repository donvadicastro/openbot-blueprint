-- Evidence is written by the workspace provider boundary, never by a bot.
create table if not exists bp_phase_workspace_evidence (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  tool_key text not null,
  evidence_id text not null,
  exit_code integer not null,
  stdout text not null,
  stderr text not null,
  digest text not null,
  created_at timestamptz not null default now(),
  primary key (project_id,run_id,occurrence_id,tool_key),
  unique (project_id,evidence_id),
  foreign key (project_id,run_id,occurrence_id,tool_key)
    references bp_phase_workspace_grants(project_id,run_id,occurrence_id,tool_key)
);
drop trigger if exists bp_phase_workspace_evidence_immutable on bp_phase_workspace_evidence;
create trigger bp_phase_workspace_evidence_immutable before update or delete on bp_phase_workspace_evidence
  for each row execute function bp_immutable_record();
