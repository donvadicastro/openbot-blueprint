-- A QA receipt must identify the exact Git candidate tested in the sandbox.
alter table bp_phase_workspace_evidence add column if not exists qa_revision text;
alter table bp_phase_workspace_evidence drop constraint if exists bp_phase_workspace_evidence_qa_revision_check;
alter table bp_phase_workspace_evidence add constraint bp_phase_workspace_evidence_qa_revision_check
  check (qa_revision is null or qa_revision ~ '^[a-f0-9]{40,64}$');
