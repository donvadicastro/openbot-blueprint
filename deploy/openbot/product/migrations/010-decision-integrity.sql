-- Apply the stricter rule to installations that already recorded migration 004.
alter table bp_workflow_decisions drop constraint if exists bp_workflow_decisions_check;
alter table bp_workflow_decisions add constraint bp_workflow_decisions_check
  check ((state = 'Answered' and answer is not null and answered_by is not null and answered_at is not null)
    or (state <> 'Answered' and answer is null and answered_by is null and answered_at is null));
