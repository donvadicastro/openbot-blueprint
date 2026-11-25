-- A claimed phase is never dispatched a second time merely because a reply was lost.
create table if not exists bp_phase_activity_receipts (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  request_digest text not null,
  state text not null check (state in ('Running','Completed')),
  outcome jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (project_id,run_id,occurrence_id,attempt),
  foreign key (project_id,run_id,occurrence_id,attempt)
    references bp_action_attempts(project_id,run_id,occurrence_id,attempt),
  check ((state='Running' and outcome is null and completed_at is null) or
    (state='Completed' and jsonb_typeof(outcome)='object' and completed_at is not null))
);
create or replace function bp_preserve_phase_activity_receipt() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.state = 'Completed' or
    (new.project_id,new.run_id,new.occurrence_id,new.attempt,new.request_digest,new.created_at)
    is distinct from (old.project_id,old.run_id,old.occurrence_id,old.attempt,old.request_digest,old.created_at) then
    raise exception 'phase activity receipts cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_phase_activity_receipts_immutable on bp_phase_activity_receipts;
create trigger bp_phase_activity_receipts_immutable before update or delete on bp_phase_activity_receipts
  for each row execute function bp_preserve_phase_activity_receipt();
