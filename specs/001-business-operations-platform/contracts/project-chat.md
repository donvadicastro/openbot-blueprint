# Project, Chat, and Operator Contract

These are planned authenticated OpenBot extension routes and UI behaviors. Routes use the native signed-in actor. The service derives project scope from the resource and its parent records on every operation. Use the existing folder picker and conversation routes where compatible.

| Interface | Request and result |
| --- | --- |
| `GET /api/products` | Return projects visible to the actor, their blueprint version, readiness state, and Team Lead conversation reference. |
| `POST /api/products` | Create a named project from a published version of the installed blueprint. An idempotency key deduplicates the same request. Return the project and Team Lead conversation in Initializing. |
| `POST /api/products/:id/initialization` | Submit selected folder and typed artifact bindings or retry failed checks. Return VM status and readiness reports with outstanding inputs and reasons. |
| `POST /api/products/:id/work-items` | Accept a message/outcome and its originating project conversation. Return a stable work item and current status. During initialization report readiness blockers. |
| `GET /api/products/:id/work-items/:workId` | Return phase, assigned role, waiting reason, decisions, attempt timeline, evidence references, and authorized chat views. |
| `POST /api/products/:id/work-items/:workId/decisions` | Record an authorized answer or release decision against a pending decision ID and expected run revision. Approval includes the candidate and target reference. Resume the existing run. |
| `POST /api/products/:id/assignments/:assignmentId/feedback` | Record authorized feedback with its source and update scoped guidance when applicable. Return current revision or the clarification needed. |
| `POST /api/products/:id/archive` | Archive the project, preserving access to history for authorized members and blocking new work. |

Return structured validation failures with field or artifact IDs. Use 404 for resources the actor cannot discover, 403 for actions denied on visible resources, 409 for stale revisions or readiness conflicts, and 422 for invalid payloads. Repeating a request with the same idempotency key and payload returns the existing outcome. A changed payload using that key is a conflict.

## Team Lead and specialist views

Open a project into its Team Lead conversation. Show readiness results during setup and questions, decisions, status and evidence after setup. Specialists appear through blueprint role views in the originating conversation. A view is keyed by project, conversation, work item, run, and role. The UI uses shared, registered components for blueprint-selected fields and detail sections.

Use AG-UI 1.0 state events with the pinned app’s `@ag-ui/core` 1.0.2. The first event for a view or reconnect is a `STATE_SNAPSHOT` with the authorized state. Later `STATE_DELTA` events patch the previous authorized projection. On a gap, reconnect for a snapshot and show last known state until it arrives. Recheck access on update and clear the view on permission loss. Publish state from durable project records, including while the initial assistant turn is closed. A2UI 1.0 basic components are the first renderer to evaluate. [AG-UI state](https://docs.ag-ui.com/concepts/state) · [Pinned renderer](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/app/src/lib/copilot/a2ui.ts)

QA shows the candidate and scenario progress while running. The final summary shows verdict, counts, pass rate and next phase. Users can open a scenario’s steps, expected and observed results, and authorized evidence. Reopening the conversation restores the final view for the same run. [Workflow records](blueprint-workflow.md)
