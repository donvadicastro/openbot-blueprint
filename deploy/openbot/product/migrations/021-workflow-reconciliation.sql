-- Wake an uncertain workflow after the feedback blocking its specialist is clarified.
create table if not exists bp_reconciliation_intents (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  assignment_id text not null,
  conflict_id text not null,
  state text not null default 'Pending' check (state in ('Pending','Sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  failures integer not null default 0,
  primary key(project_id,run_id,occurrence_id,conflict_id),
  foreign key(project_id,run_id,occurrence_id) references bp_phase_occurrences(project_id,run_id,id),
  foreign key(project_id,assignment_id,conflict_id) references bp_memory_conflicts(project_id,assignment_id,id),
  check ((state='Pending' and sent_at is null) or (state='Sent' and sent_at is not null))
);
