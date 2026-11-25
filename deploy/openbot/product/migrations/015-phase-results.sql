-- Accepted specialist results are immutable; applying a transition is separate.
create table if not exists bp_phase_results (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  result_digest text not null,
  result jsonb not null check (jsonb_typeof(result)='object'),
  created_at timestamptz not null default now(),
  primary key (project_id,run_id,occurrence_id,attempt),
  foreign key (project_id,run_id,occurrence_id,attempt)
    references bp_action_attempts(project_id,run_id,occurrence_id,attempt)
);
drop trigger if exists bp_phase_results_immutable on bp_phase_results;
create trigger bp_phase_results_immutable before update or delete on bp_phase_results
  for each row execute function bp_immutable_record();
