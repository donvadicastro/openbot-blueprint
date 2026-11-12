-- Memory belongs to an assignment in one project, never to a shared bot definition.
create table if not exists bp_memory_entries (
  project_id text not null,
  assignment_id text not null,
  id text not null,
  current_revision integer not null check (current_revision > 0),
  primary key (project_id, assignment_id, id),
  foreign key (project_id, assignment_id) references bp_assignments(project_id, id)
);

create table if not exists bp_memory_revisions (
  project_id text not null,
  assignment_id text not null,
  entry_id text not null,
  revision integer not null check (revision > 0),
  guidance text not null check (length(trim(guidance)) between 1 and 4000),
  feedback_source jsonb not null check (jsonb_typeof(feedback_source) = 'object'),
  author_id text not null references users(id),
  created_at timestamptz not null default now(),
  primary key (project_id, assignment_id, entry_id, revision),
  foreign key (project_id, assignment_id, entry_id) references bp_memory_entries(project_id, assignment_id, id)
);
drop trigger if exists bp_memory_revisions_immutable on bp_memory_revisions;
create trigger bp_memory_revisions_immutable before update or delete on bp_memory_revisions
  for each row execute function bp_immutable_record();
