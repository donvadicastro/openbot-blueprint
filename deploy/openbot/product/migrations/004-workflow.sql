-- Every relationship carries the project key to prevent cross-project joins.
create table if not exists bp_work_items (
  project_id text not null references bp_projects(id),
  id text not null,
  native_channel_id text not null,
  requested_by text not null references users(id),
  request text not null check (length(trim(request)) > 0),
  created_at timestamptz not null default now(),
  primary key (project_id, id),
  foreign key (project_id, native_channel_id) references bp_conversations(project_id, native_channel_id)
);

create unique index if not exists bp_project_blueprint_binding on bp_projects(id, blueprint_key, blueprint_version);
create table if not exists bp_workflow_runs (
  project_id text not null,
  id text not null,
  work_item_id text not null,
  blueprint_key text not null,
  blueprint_version text not null,
  workflow_key text,
  plan_digest text not null,
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  current_phase text not null,
  state text not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id),
  foreign key (project_id, work_item_id) references bp_work_items(project_id, id),
  foreign key (project_id, blueprint_key, blueprint_version) references bp_projects(id, blueprint_key, blueprint_version),
  foreign key (blueprint_key, blueprint_version) references bp_blueprint_versions(blueprint_key, version)
);

create table if not exists bp_phase_occurrences (
  project_id text not null,
  run_id text not null,
  id text not null,
  phase_key text not null,
  occurrence integer not null check (occurrence > 0),
  action_key text not null,
  assignment_id text not null,
  operation_key text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, run_id, id),
  unique (project_id, run_id, phase_key, occurrence),
  unique (project_id, run_id, id, operation_key),
  unique (project_id, operation_key),
  foreign key (project_id, run_id) references bp_workflow_runs(project_id, id),
  foreign key (project_id, assignment_id) references bp_assignments(project_id, id)
);

create table if not exists bp_action_attempts (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null check (attempt > 0),
  state text not null,
  input_revisions jsonb not null default '[]'::jsonb check (jsonb_typeof(input_revisions) = 'array'),
  output_revisions jsonb not null default '[]'::jsonb check (jsonb_typeof(output_revisions) = 'array'),
  reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (project_id, run_id, occurrence_id, attempt),
  foreign key (project_id, run_id, occurrence_id) references bp_phase_occurrences(project_id, run_id, id)
);

create table if not exists bp_workflow_transitions (
  project_id text not null,
  run_id text not null,
  sequence bigint not null check (sequence > 0),
  from_phase text not null,
  to_phase text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  primary key (project_id, run_id, sequence),
  foreign key (project_id, run_id) references bp_workflow_runs(project_id, id)
);

create table if not exists bp_workflow_decisions (
  project_id text not null,
  run_id text not null,
  id text not null,
  question text not null,
  state text not null check (state in ('Pending', 'Answered', 'Cancelled')),
  answer jsonb,
  answered_by text references users(id),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  primary key (project_id, run_id, id),
  foreign key (project_id, run_id) references bp_workflow_runs(project_id, id),
  check ((state = 'Answered' and answer is not null and answered_by is not null and answered_at is not null)
    or (state <> 'Answered' and answer is null and answered_by is null and answered_at is null))
);

create table if not exists bp_dispatch_intents (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  operation_key text not null,
  state text not null check (state in ('Pending', 'Dispatched', 'Completed', 'Uncertain')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, run_id, occurrence_id, attempt),
  foreign key (project_id, run_id, occurrence_id, attempt) references bp_action_attempts(project_id, run_id, occurrence_id, attempt),
  foreign key (project_id, run_id, occurrence_id, operation_key) references bp_phase_occurrences(project_id, run_id, id, operation_key)
);

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
create trigger bp_workflow_run_plan_immutable before update on bp_workflow_runs
  for each row execute function bp_preserve_run_plan();

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
create trigger bp_phase_identity_immutable before update on bp_phase_occurrences
  for each row execute function bp_preserve_phase_identity();
drop trigger if exists bp_workflow_transition_immutable on bp_workflow_transitions;
create or replace function bp_preserve_workflow_transition() returns trigger language plpgsql as $$
begin
  raise exception 'workflow transitions are immutable' using errcode = '23514';
end;
$$;
create trigger bp_workflow_transition_immutable before update or delete on bp_workflow_transitions
  for each row execute function bp_preserve_workflow_transition();

create index if not exists bp_workflow_runs_work_item on bp_workflow_runs(project_id, work_item_id, created_at);
create index if not exists bp_dispatch_pending on bp_dispatch_intents(state, created_at) where state = 'Pending';
