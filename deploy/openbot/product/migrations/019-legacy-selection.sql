-- Once an owner chooses conversations, automatic migration must respect that choice.
create table if not exists bp_legacy_manual_selections (
  installation_id text not null,
  owner_id text not null,
  legacy_key text not null,
  created_at timestamptz not null default now(),
  primary key (installation_id,owner_id,legacy_key),
  foreign key (installation_id,owner_id,legacy_key)
    references bp_legacy_project_groups(installation_id,owner_id,legacy_key)
);
