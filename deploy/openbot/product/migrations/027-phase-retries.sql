-- Each safe retry has a new occurrence, while retaining its original lineage.
create table if not exists bp_phase_retry_lineage (
  project_id text not null,
  run_id text not null,
  occurrence_id text not null,
  root_occurrence_id text not null,
  parent_occurrence_id text not null,
  attempt_number integer not null check (attempt_number >= 2),
  primary key (project_id,run_id,occurrence_id),
  foreign key (project_id,run_id,occurrence_id) references bp_phase_occurrences(project_id,run_id,id),
  foreign key (project_id,run_id,root_occurrence_id) references bp_phase_occurrences(project_id,run_id,id),
  foreign key (project_id,run_id,parent_occurrence_id) references bp_phase_occurrences(project_id,run_id,id)
);
drop trigger if exists bp_phase_retry_lineage_immutable on bp_phase_retry_lineage;
create trigger bp_phase_retry_lineage_immutable before update or delete on bp_phase_retry_lineage
  for each row execute function bp_immutable_record();
