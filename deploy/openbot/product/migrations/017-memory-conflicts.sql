-- Ambiguous feedback is held separately until an authorized person resolves it.
create table if not exists bp_memory_conflicts (
  project_id text not null,
  assignment_id text not null,
  id text not null,
  entry_id text not null,
  base_revision integer not null,
  proposed_guidance text not null check (length(trim(proposed_guidance)) between 1 and 4000),
  feedback_source jsonb not null check (jsonb_typeof(feedback_source)='object'),
  author_id text not null references users(id),
  state text not null default 'Pending' check (state in ('Pending','Resolved')),
  resolution_revision integer,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key (project_id,assignment_id,id),
  foreign key (project_id,assignment_id,entry_id,base_revision)
    references bp_memory_revisions(project_id,assignment_id,entry_id,revision),
  foreign key (project_id,assignment_id,entry_id,resolution_revision)
    references bp_memory_revisions(project_id,assignment_id,entry_id,revision),
  check ((state='Pending' and resolution_revision is null and resolved_at is null) or
    (state='Resolved' and resolution_revision is not null and resolved_at is not null))
);
create unique index if not exists bp_memory_one_pending_conflict on bp_memory_conflicts(project_id,assignment_id,entry_id) where state='Pending';
create or replace function bp_preserve_memory_conflict() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or old.state='Resolved' or
    (new.project_id,new.assignment_id,new.id,new.entry_id,new.base_revision,new.proposed_guidance,new.feedback_source,new.author_id,new.created_at)
    is distinct from (old.project_id,old.assignment_id,old.id,old.entry_id,old.base_revision,old.proposed_guidance,old.feedback_source,old.author_id,old.created_at) then
    raise exception 'memory conflict history cannot be changed' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_memory_conflict_immutable on bp_memory_conflicts;
create trigger bp_memory_conflict_immutable before update or delete on bp_memory_conflicts
  for each row execute function bp_preserve_memory_conflict();
