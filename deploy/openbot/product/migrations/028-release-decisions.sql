-- Link a human decision to one immutable release proposal and phase result.
create table if not exists bp_release_decision_bindings (
  project_id text not null,
  run_id text not null,
  decision_id text not null,
  proposal_id text not null,
  primary key(project_id,run_id,decision_id),
  unique(project_id,run_id,proposal_id),
  foreign key(project_id,run_id,decision_id) references bp_phase_decision_bindings(project_id,run_id,decision_id),
  foreign key(project_id,run_id,proposal_id) references bp_release_proposals(project_id,run_id,id)
);
drop trigger if exists bp_release_decision_bindings_immutable on bp_release_decision_bindings;
create trigger bp_release_decision_bindings_immutable before update or delete on bp_release_decision_bindings
  for each row execute function bp_immutable_record();

-- A proposal's reviewed evidence must remain bound to the decision.
create or replace function bp_preserve_release_binding() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'bp_release_proposals' then
    if (new.project_id,new.run_id,new.id,new.candidate_artifact_id,new.candidate_revision_id,new.target,new.evidence,new.created_at)
       is distinct from (old.project_id,old.run_id,old.id,old.candidate_artifact_id,old.candidate_revision_id,old.target,old.evidence,old.created_at) then
      raise exception 'release proposal bindings are immutable' using errcode = '23514';
    end if;
  elsif (new.project_id,new.run_id,new.proposal_id,new.operation_key,new.created_at)
        is distinct from (old.project_id,old.run_id,old.proposal_id,old.operation_key,old.created_at) then
    raise exception 'release operation key is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
