/** Only display known, server-generated codes. Never render engine-provided text. */
export function workflowStatusMessage(code: unknown): string {
  switch (code) {
    case 'specialist-unavailable': return 'The specialist or approval capability is not available yet.';
    case 'release-inputs-unavailable': return 'Release preparation needs the current candidate, passing QA evidence and release inputs.';
    case 'protected-workspace-unavailable': return 'The protected project workspace or candidate is unavailable.';
    case 'specialist-result-unconfirmed': return 'The specialist did not return a confirmed result.';
    case 'specialist-result-invalid': return 'The specialist returned an invalid result.';
    case 'phase-result-unconfirmed': return 'The previous workflow action did not return a confirmed result.';
    case 'phase-reconciliation-unavailable': return 'The previous workflow action could not yet be checked.';
    case 'release-reconciliation': return 'The staging deployment needs to be checked before work can continue.';
    case 'release-verification': return 'The staging deployment was recorded, but its verification is not confirmed.';
    case 'release-target-unavailable': return 'The staging target is not configured.';
    case 'release-target-mismatch': return 'The approved staging target does not match the configured target.';
    case 'release-rejected': return 'The release was rejected by its approver; no deployment was started.';
    case 'specialist-retries-exhausted': return 'The specialist could not complete this phase within its retry limit.';
    case 'workflow-plan-invalid': return 'The workflow returned a phase outside the saved plan and was stopped.';
    case 'workflow-phase-limit': return 'The workflow reached its configured phase limit and was stopped.';
    default: return 'The workflow is waiting for its previous action to be checked.';
  }
}
