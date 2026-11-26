create table if not exists bp_release_proposals (
  project_id text not null,
  run_id text not null,
  id text not null,
  candidate_artifact_id text not null,
  candidate_revision_id text not null,
  target text not null check (length(trim(target)) > 0),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  state text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, run_id, id),
  unique (project_id, run_id, id, candidate_artifact_id, candidate_revision_id, target),
  foreign key (project_id, run_id) references bp_workflow_runs(project_id, id),
  foreign key (project_id, candidate_artifact_id, candidate_revision_id) references bp_artifact_revisions(project_id, artifact_id, id)
);

create table if not exists bp_release_approvals (
  project_id text not null,
  run_id text not null,
  proposal_id text not null,
  id text not null,
  candidate_artifact_id text not null,
  candidate_revision_id text not null,
  target text not null,
  approver_id text not null references users(id),
  decision text not null check (decision in ('Approved', 'Rejected')),
  decided_at timestamptz not null default now(),
  primary key (project_id, run_id, proposal_id, id),
  foreign key (project_id, run_id, proposal_id, candidate_artifact_id, candidate_revision_id, target)
    references bp_release_proposals(project_id, run_id, id, candidate_artifact_id, candidate_revision_id, target)
);

create table if not exists bp_release_effects (
  project_id text not null,
  run_id text not null,
  proposal_id text not null,
  operation_key text not null,
  state text not null check (state in ('Pending', 'Dispatching', 'Confirmed', 'Uncertain')),
  receipt jsonb,
  verification jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, run_id, proposal_id),
  unique (project_id, operation_key),
  foreign key (project_id, run_id, proposal_id) references bp_release_proposals(project_id, run_id, id),
  check (receipt is null or jsonb_typeof(receipt) = 'object'),
  check (verification is null or jsonb_typeof(verification) = 'object')
);

create or replace function bp_preserve_release_binding() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'bp_release_proposals' then
    if (new.candidate_artifact_id, new.candidate_revision_id, new.target)
       is distinct from (old.candidate_artifact_id, old.candidate_revision_id, old.target) then
      raise exception 'release proposal bindings are immutable' using errcode = '23514';
    end if;
  elsif new.operation_key is distinct from old.operation_key then
    raise exception 'release operation key is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_release_proposal_binding_immutable on bp_release_proposals;
create trigger bp_release_proposal_binding_immutable before update on bp_release_proposals
  for each row execute function bp_preserve_release_binding();
drop trigger if exists bp_release_effect_key_immutable on bp_release_effects;
create trigger bp_release_effect_key_immutable before update on bp_release_effects
  for each row execute function bp_preserve_release_binding();
drop trigger if exists bp_release_approval_immutable on bp_release_approvals;
create or replace function bp_preserve_release_approval() returns trigger language plpgsql as $$
begin
  raise exception 'release approvals are immutable' using errcode = '23514';
end;
$$;
create trigger bp_release_approval_immutable before update or delete on bp_release_approvals
  for each row execute function bp_preserve_release_approval();
