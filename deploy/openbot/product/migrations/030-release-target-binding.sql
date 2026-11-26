-- Reconciliation must use the same target service that received the operation.
create table if not exists bp_release_target_bindings (
  project_id text not null,
  run_id text not null,
  proposal_id text not null,
  target_id text not null,
  endpoint_origin text not null,
  created_at timestamptz not null default now(),
  primary key(project_id,run_id,proposal_id),
  foreign key(project_id,run_id,proposal_id) references bp_release_effects(project_id,run_id,proposal_id)
);
drop trigger if exists bp_release_target_bindings_immutable on bp_release_target_bindings;
create trigger bp_release_target_bindings_immutable before update or delete on bp_release_target_bindings
  for each row execute function bp_immutable_record();
