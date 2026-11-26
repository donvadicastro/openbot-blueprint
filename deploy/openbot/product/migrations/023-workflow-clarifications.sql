-- A free-text clarification is bound to the exact specialist result that asked it.
create table if not exists bp_phase_clarifications (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  decision_id text not null,
  result_digest text not null,
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,occurrence_id,attempt),
  unique(project_id,run_id,decision_id),
  foreign key(project_id,run_id,decision_id) references bp_workflow_decisions(project_id,run_id,id),
  foreign key(project_id,run_id,occurrence_id,attempt) references bp_action_attempts(project_id,run_id,occurrence_id,attempt)
);
drop trigger if exists bp_phase_clarifications_immutable on bp_phase_clarifications;
create trigger bp_phase_clarifications_immutable before update or delete on bp_phase_clarifications
  for each row execute function bp_immutable_record();

-- The next attempt is a continuation of the same occurrence, not a new effect.
create table if not exists bp_attempt_clarifications (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  decision_id text not null,
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,occurrence_id,attempt),
  unique(project_id,run_id,decision_id),
  foreign key(project_id,run_id,occurrence_id,attempt) references bp_action_attempts(project_id,run_id,occurrence_id,attempt),
  foreign key(project_id,run_id,decision_id) references bp_phase_clarifications(project_id,run_id,decision_id)
);
drop trigger if exists bp_attempt_clarifications_immutable on bp_attempt_clarifications;
create trigger bp_attempt_clarifications_immutable before update or delete on bp_attempt_clarifications
  for each row execute function bp_immutable_record();
