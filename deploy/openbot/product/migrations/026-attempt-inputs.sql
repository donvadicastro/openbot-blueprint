-- Input revisions define what an attempt was authorized to process.
create or replace function bp_preserve_attempt_inputs() returns trigger language plpgsql as $$
begin
  if (new.project_id,new.run_id,new.occurrence_id,new.attempt,new.input_revisions,new.started_at)
     is distinct from (old.project_id,old.run_id,old.occurrence_id,old.attempt,old.input_revisions,old.started_at) then
    raise exception 'workflow attempt inputs are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_attempt_inputs_immutable on bp_action_attempts;
create trigger bp_attempt_inputs_immutable before update on bp_action_attempts
  for each row execute function bp_preserve_attempt_inputs();
