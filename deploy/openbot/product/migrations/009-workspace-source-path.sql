alter table bp_project_vms add column if not exists imported_source_path text;
update bp_project_vms v set imported_source_path = a.source->>'path'
from bp_artifacts a
where a.project_id = v.project_id and a.type_key = 'source-code'
  and v.source_revision is not null and v.imported_source_path is null;
