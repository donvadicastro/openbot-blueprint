create table if not exists bp_installations (
  id text primary key,
  environment_id text not null,
  blueprint_key text not null,
  compose_project text not null,
  app_url text not null,
  created_at timestamptz not null default now(),
  unique (environment_id, blueprint_key),
  unique (environment_id, compose_project),
  unique (id, blueprint_key)
);

create table if not exists bp_blueprint_versions (
  blueprint_key text not null,
  version text not null,
  digest text not null,
  definition jsonb not null,
  published_by text not null references users(id),
  published_at timestamptz not null default now(),
  primary key (blueprint_key, version),
  check (jsonb_typeof(definition) = 'object')
);

create table if not exists bp_projects (
  id text primary key,
  installation_id text not null,
  blueprint_key text not null,
  blueprint_version text not null,
  name text not null check (length(trim(name)) between 1 and 200),
  state text not null default 'Initializing' check (state in ('Initializing', 'Operational', 'Archived')),
  revision integer not null default 1 check (revision > 0),
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  foreign key (installation_id, blueprint_key) references bp_installations(id, blueprint_key),
  foreign key (blueprint_key, blueprint_version) references bp_blueprint_versions(blueprint_key, version)
);

create table if not exists bp_memberships (
  project_id text not null references bp_projects(id),
  user_id text not null references users(id),
  permissions text[] not null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id),
  check (permissions <@ array['read', 'manage', 'work', 'approve', 'feedback']::text[])
);

create table if not exists bp_assignments (
  project_id text not null references bp_projects(id),
  id text not null,
  role_key text not null,
  native_bot_id text not null,
  permissions jsonb not null default '{}'::jsonb,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  primary key (project_id, id),
  unique (project_id, role_key),
  check (jsonb_typeof(permissions) = 'object')
);

create table if not exists bp_conversations (
  project_id text not null references bp_projects(id),
  native_channel_id text not null references channels(id),
  team_lead_assignment_id text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, native_channel_id),
  unique (native_channel_id),
  foreign key (project_id, team_lead_assignment_id) references bp_assignments(project_id, id)
);

create table if not exists bp_artifacts (
  project_id text not null references bp_projects(id),
  id text not null,
  type_key text not null,
  owner_assignment_id text,
  source jsonb not null,
  status text not null,
  allowed_user_ids text[],
  created_at timestamptz not null default now(),
  primary key (project_id, id),
  foreign key (project_id, owner_assignment_id) references bp_assignments(project_id, id),
  check (jsonb_typeof(source) = 'object')
);

create table if not exists bp_artifact_revisions (
  project_id text not null,
  artifact_id text not null,
  id text not null,
  digest text not null,
  payload jsonb not null,
  evidence jsonb not null default '{}'::jsonb,
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  primary key (project_id, artifact_id, id),
  foreign key (project_id, artifact_id) references bp_artifacts(project_id, id),
  check (jsonb_typeof(payload) = 'object'),
  check (jsonb_typeof(evidence) = 'object')
);

create table if not exists bp_mutations (
  project_id text not null references bp_projects(id),
  actor_id text not null references users(id),
  mutation_key text not null,
  digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, actor_id, mutation_key)
);

create table if not exists bp_installation_mutations (
  installation_id text not null references bp_installations(id),
  actor_id text not null references users(id),
  mutation_key text not null,
  digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (installation_id, actor_id, mutation_key)
);

create index if not exists bp_memberships_user on bp_memberships(user_id, project_id);
create index if not exists bp_artifact_revisions_newest on bp_artifact_revisions(project_id, artifact_id, created_at desc, id desc);

create or replace function bp_immutable_record() returns trigger language plpgsql as $$
begin
  raise exception 'published blueprint versions and artifact revisions are immutable' using errcode = '23514';
end;
$$;
drop trigger if exists bp_blueprint_versions_immutable on bp_blueprint_versions;
create trigger bp_blueprint_versions_immutable before update or delete on bp_blueprint_versions
  for each row execute function bp_immutable_record();
drop trigger if exists bp_artifact_revisions_immutable on bp_artifact_revisions;
create trigger bp_artifact_revisions_immutable before update or delete on bp_artifact_revisions
  for each row execute function bp_immutable_record();
