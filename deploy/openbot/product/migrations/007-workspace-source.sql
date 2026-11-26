alter table bp_project_vms add column if not exists excludes_uncommitted_changes boolean not null default false;
