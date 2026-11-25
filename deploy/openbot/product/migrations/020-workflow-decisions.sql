-- The decision belongs to one exact validated phase result and attempt.
create table if not exists bp_phase_decision_bindings (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  decision_id text not null,
  result_digest text not null,
  choices jsonb not null check (jsonb_typeof(choices)='array' and jsonb_array_length(choices)>0),
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,occurrence_id,attempt),
  unique(project_id,run_id,decision_id),
  foreign key(project_id,run_id,decision_id) references bp_workflow_decisions(project_id,run_id,id),
  foreign key(project_id,run_id,occurrence_id,attempt) references bp_action_attempts(project_id,run_id,occurrence_id,attempt)
);
drop trigger if exists bp_phase_decision_bindings_immutable on bp_phase_decision_bindings;
create trigger bp_phase_decision_bindings_immutable before update or delete on bp_phase_decision_bindings
  for each row execute function bp_immutable_record();

create table if not exists bp_decision_signal_intents (
  project_id text not null,
  run_id text not null,
  decision_id text not null,
  state text not null default 'Pending' check (state in ('Pending','Sent')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  failures integer not null default 0,
  primary key(project_id,run_id,decision_id),
  foreign key(project_id,run_id,decision_id) references bp_workflow_decisions(project_id,run_id,id),
  check ((state='Pending' and sent_at is null) or (state='Sent' and sent_at is not null))
);

create or replace function bp_preserve_workflow_decision() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or old.state <> 'Pending' or
    (new.project_id,new.run_id,new.id,new.question,new.created_at) is distinct from
    (old.project_id,old.run_id,old.id,old.question,old.created_at) or new.state not in ('Answered','Cancelled') then
    raise exception 'workflow decision history cannot be changed' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_workflow_decisions_immutable on bp_workflow_decisions;
create trigger bp_workflow_decisions_immutable before update or delete on bp_workflow_decisions
  for each row execute function bp_preserve_workflow_decision();
