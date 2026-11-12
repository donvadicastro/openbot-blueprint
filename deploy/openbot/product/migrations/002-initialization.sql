create table if not exists bp_project_vms (
  project_id text primary key references bp_projects(id),
  provider_id text,
  source_revision text,
  state text not null default 'Pending',
  reason text,
  updated_at timestamptz not null default now()
);
create table if not exists bp_readiness (
  project_id text not null,
  assignment_id text not null,
  assignment_revision integer not null,
  input_digest text not null,
  status text not null check(status in ('Ready','Blocked')),
  evidence jsonb not null,
  checked_at timestamptz not null default now(),
  primary key(project_id, assignment_id),
  foreign key(project_id, assignment_id) references bp_assignments(project_id,id)
);
