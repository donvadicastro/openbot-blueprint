alter table bp_project_vms add column if not exists excluded_paths jsonb not null default '[]'::jsonb;
