-- A bot cannot name a project phase or operation in its tool arguments.
-- Only the trusted workflow dispatcher records these immutable bindings.
create table if not exists bp_phase_workspace_grants (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  tool_key text not null check (tool_key in ('workspace-edit', 'test-runner')),
  primary key (project_id, run_id, occurrence_id),
  unique (project_id, run_id, occurrence_id, tool_key),
  foreign key (project_id, run_id, occurrence_id) references bp_phase_occurrences(project_id, run_id, id)
);
drop trigger if exists bp_phase_workspace_grants_immutable on bp_phase_workspace_grants;
create trigger bp_phase_workspace_grants_immutable before update or delete on bp_phase_workspace_grants
  for each row execute function bp_immutable_record();

create table if not exists bp_native_action_runs (
  project_id text not null,
  native_run_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null check (attempt > 0),
  assignment_id text not null,
  actor_id text not null references users(id),
  tool_key text not null check (tool_key in ('workspace-edit', 'test-runner')),
  created_at timestamptz not null default now(),
  primary key (project_id, native_run_id),
  unique (native_run_id),
  unique (project_id, run_id, occurrence_id, attempt),
  foreign key (project_id, run_id, occurrence_id, attempt)
    references bp_action_attempts(project_id, run_id, occurrence_id, attempt),
  foreign key (project_id, run_id, occurrence_id, tool_key)
    references bp_phase_workspace_grants(project_id, run_id, occurrence_id, tool_key),
  foreign key (project_id, assignment_id) references bp_assignments(project_id, id)
);
drop trigger if exists bp_native_action_runs_immutable on bp_native_action_runs;
create trigger bp_native_action_runs_immutable before update or delete on bp_native_action_runs
  for each row execute function bp_immutable_record();
