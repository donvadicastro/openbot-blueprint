-- A blocked project must not starve other pending initial dispatches.
alter table bp_dispatch_intents add column if not exists next_attempt_at timestamptz not null default now();
alter table bp_dispatch_intents add column if not exists dispatch_failures integer not null default 0 check (dispatch_failures >= 0);
create index if not exists bp_dispatch_retry_due on bp_dispatch_intents(next_attempt_at, created_at) where state='Pending';
