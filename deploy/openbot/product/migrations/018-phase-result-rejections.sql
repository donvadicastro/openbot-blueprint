-- Record rejected results without retaining untrusted specialist output.
create table if not exists bp_phase_result_rejections (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  attempt integer not null,
  result_digest text not null,
  code text not null,
  created_at timestamptz not null default now(),
  primary key (project_id,run_id,occurrence_id,attempt,result_digest,code),
  foreign key (project_id,run_id,occurrence_id,attempt)
    references bp_action_attempts(project_id,run_id,occurrence_id,attempt)
);
drop trigger if exists bp_phase_result_rejections_immutable on bp_phase_result_rejections;
create trigger bp_phase_result_rejections_immutable before update or delete on bp_phase_result_rejections
  for each row execute function bp_immutable_record();
