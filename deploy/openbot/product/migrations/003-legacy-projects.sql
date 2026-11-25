-- One legacy owner/source group maps to one stable project. New projects are
-- deliberately absent from this table, even when they use the same folder.
create table if not exists bp_legacy_project_groups (
  installation_id text not null references bp_installations(id),
  owner_id text not null references users(id),
  legacy_key text not null,
  project_id text not null references bp_projects(id),
  created_at timestamptz not null default now(),
  primary key (installation_id, owner_id, legacy_key),
  unique (project_id)
);
