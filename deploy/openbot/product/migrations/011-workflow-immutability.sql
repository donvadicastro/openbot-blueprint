-- Apply occurrence and history protections to installations that already ran 004.
create or replace function bp_preserve_run_plan() returns trigger language plpgsql as $$
begin
  if (new.project_id, new.id, new.work_item_id, new.blueprint_key, new.blueprint_version, new.workflow_key, new.plan_digest, new.plan)
    is distinct from (old.project_id, old.id, old.work_item_id, old.blueprint_key, old.blueprint_version, old.workflow_key, old.plan_digest, old.plan) then
    raise exception 'workflow run plans are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_workflow_run_plan_immutable on bp_workflow_runs;
create trigger bp_workflow_run_plan_immutable before update on bp_workflow_runs for each row execute function bp_preserve_run_plan();

create or replace function bp_preserve_phase_identity() returns trigger language plpgsql as $$
begin
  if (new.project_id, new.run_id, new.id, new.phase_key, new.occurrence, new.action_key, new.assignment_id, new.operation_key)
    is distinct from (old.project_id, old.run_id, old.id, old.phase_key, old.occurrence, old.action_key, old.assignment_id, old.operation_key) then
    raise exception 'phase occurrence identities are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_phase_identity_immutable on bp_phase_occurrences;
create trigger bp_phase_identity_immutable before update on bp_phase_occurrences for each row execute function bp_preserve_phase_identity();

create or replace function bp_preserve_workflow_transition() returns trigger language plpgsql as $$
begin
  raise exception 'workflow transitions are immutable' using errcode = '23514';
end;
$$;
drop trigger if exists bp_workflow_transition_immutable on bp_workflow_transitions;
create trigger bp_workflow_transition_immutable before update or delete on bp_workflow_transitions for each row execute function bp_preserve_workflow_transition();
