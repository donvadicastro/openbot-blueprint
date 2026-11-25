-- Per-scenario progress is append-only and belongs to a specific phase attempt.
create table if not exists bp_qa_scenario_events (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  scenario_id text not null,
  sequence integer not null check (sequence > 0),
  plan_revision text not null,
  candidate_revision text not null,
  status text not null check (status in ('queued','running','passed','failed','blocked','not-run')),
  observed text,
  reason text,
  evidence_id text,
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,occurrence_id,attempt,scenario_id,sequence),
  foreign key(project_id,run_id,occurrence_id,attempt)
    references bp_action_attempts(project_id,run_id,occurrence_id,attempt),
  foreign key(project_id,evidence_id) references bp_phase_workspace_evidence(project_id,evidence_id)
);
drop trigger if exists bp_qa_scenario_events_immutable on bp_qa_scenario_events;
create trigger bp_qa_scenario_events_immutable before update or delete on bp_qa_scenario_events
  for each row execute function bp_immutable_record();
