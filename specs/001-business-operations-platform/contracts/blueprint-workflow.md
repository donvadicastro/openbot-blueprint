# Blueprint and Workflow Contract

The existing blueprint CLI remains the validation and export entry point. Validate shape and cross-references before publishing an immutable version. The published business contract extends the existing agent and tenant definitions.

| Field | Required content |
| --- | --- |
| `key`, `version` | Stable installation key and immutable revision. Bind a published version to its content digest. |
| `roles`, `teamLeadRole` | Role key, bot reference, specialties, startup checks, granted tools, owned actions, and view. |
| `artifactTypes`, `initialization` | Versioned schemas, relationships, owners, producers and consumers, mandatory and recommended inputs, and any workspace requirement. |
| `actions` | Assigned role, input and output types, prerequisites, expected statuses and evidence, retry policy, and any approval rule. |
| `workflows` | Outcome and matching conditions, named phases and actions, initial and terminal phases, and guarded transitions. |
| `views` | Role, supported record types, approved summary and detail fields, and reusable renderer key. |

Validate references across all sections, including every role/action pairing, type, view, and transition target. Require a reachable terminal outcome and reject conflicting transitions. Use a restricted set of declarative predicates over known action status, validated record fields, decisions, and evidence. Publication must reject overlapping conditions it cannot prove exclusive. Evaluate waits and rework as explicit states. Each transition carries the current phase occurrence and expected run revision.

## Workflow selection and execution

1. Accept a user’s outcome in Team Lead chat. Match against published workflows in the pinned blueprint. Ask for missing business intent when the choice is consequential.
2. For a clear unmatched request, accept a temporary workflow proposal in the same format. Record the applicable guidance and rationale. Resolve every proposed role and action against the project’s pinned blueprint and permissions. Require applicable evidence and approvals. Persist the validated definition and its digest on this run.
3. Persist a run and dispatch intent before starting work. Use installation, project, and run IDs as the stable engine identity. Project policy is checked again at execution, even after a wait.
4. A work request to a bot carries project, work/run and phase IDs, assignment, action key, allowed context, input revisions and expected result type. A result carries the same run and occurrence, attempt ID, status, output revisions and evidence or a failure reason. Only an authenticated, matching assignment can submit a result.
5. Validate the output, policy, and expected revision before applying a transition. Ignore a replay of a previously applied result. Reject stale or conflicting results with a reason. Retry according to the action policy and keep one operation key across attempts of the same external effect.
6. Send decisions and approvals to the same run. Pin release approval to exact candidate and target. Reconcile uncertain effects before dispatching another attempt.

## SWE acceptance records

| Record | Minimum payload and outcome |
| --- | --- |
| Change Brief | Scope, constraints, acceptance scenarios with stable IDs and expected outcomes, and links to decisions. |
| Candidate | Immutable revision/digest, source baseline and Change Brief revisions, and build evidence. |
| Test Plan | Candidate, brief, environment, required scenario IDs, prerequisites, steps, expected results. |
| QA Evidence | Exact plan and candidate references, one recorded result for every required scenario, observed outcome or reason, authorized evidence, counts and pass percentage. |
| Release | Candidate digest, QA evidence revision, runbook, target, approval decision, stable operation key, target receipt and verification result. |

QA fails when any required scenario fails. With zero failures, a blocked or unrun scenario keeps verification pending. Every required scenario must pass before proceeding. Compute the pass rate using all required scenarios as the denominator, and reject a missing, duplicate, stale, or inconsistent report. Preserve state and per-attempt diagnostics across a restart. Use the [data model](../data-model.md) for record relationships.
