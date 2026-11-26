# Data Model: Business Operations Platform

Each business project uses the blueprint identity of its OpenBot installation and pins one immutable version. PostgreSQL records carry project scope for authorization. Native user, bot, and conversation IDs are references. The product module owns workflow and readiness records.

| Entity | Fields and relationships | Rules |
| --- | --- | --- |
| Installation | `id`, environment identity, blueprint key, Compose identity, app endpoint | One binding per environment and blueprint key. Publishing another version preserves the binding. |
| Blueprint version | key, version, digest, roles, types, workflows, routes, view definitions | Unique key and version. Immutable after publish. All declared references resolve. |
| Project and membership | project ID, installation ID, pinned version, name, lifecycle state, membership with native user ID and permissions | Generate project IDs independently of the source folder. Check membership before reading or mutating scoped records. Archive retains history. |
| Bot assignment | project ID, assignment ID, role key, native bot reference, permissions, revision | One assignment per required role for the SWE pilot. Shared native bot references have separate project and assignment contexts. |
| Conversation link | project ID, native conversation ID, Team Lead assignment | Conversation belongs to one project. Validate membership before showing or posting chat and workflow updates. |
| Artifact and revision | project ID, type key, owner, access rules, source reference, revision ID, digest, status, verification evidence | Validated against the pinned type schema. Existing revisions stay immutable. Sensitive contents use authorized references. |
| Project VM | project ID, provider ID, stable provider key, base image identity, disk binding, source baseline, state, last verified time | Unique project ID and provider binding. Store VM identity before opening work. Reconcile an uncertain create against the stable provider key. |
| Readiness report | project ID, assignment revision, input revision set, status, evidence or blocker, checked time | Report applies only to the recorded prerequisites. Invalidate dependent reports on source access or assignment changes. |
| Work item and run | project ID, originating conversation, request, run ID, blueprint version, workflow reference or temporary plan digest, current phase, version, state | Temporary plan is an immutable validated snapshot for its work item. Persist the initial work state and dispatch intent together. |
| Attempt and transition | run ID, phase occurrence, action, assignee, attempt number, input and output revisions, reason, timestamps, event sequence | Stable action operation key across retries of one phase occurrence. Compare expected run revision before accepting completion. Append transition history. |
| Decision, approval, and effect | run ID, question or operation key, actor, decision, exact candidate and target for approval, timestamps, target receipt | Decision resumes the same run. Changed candidate or target needs fresh approval. Uncertain effects stay pending until reconciled. |
| Bot memory revision | project ID, assignment ID, memory entry ID, revision, guidance, feedback reference, author, updated time, supersedes ID | Scope reads and writes by project and assignment. Replace current guidance by appending a revision and advancing its current pointer atomically. |
| Chat domain view | project ID, conversation ID, work/run ID, role, view definition key, visible record references | Reconstruct from authorized records on load or reconnect. Keep the final report attached to the same run. |

## State transitions

- **Project** — Initializing → Operational when mandatory artifacts, VM, and all current readiness reports are ready. Readiness invalidation returns the project to Initializing for new work. Archive stops new work and keeps history.
- **VM** — Pending → Provisioning → Ready. Setup errors or lost access yield Blocked. Retry reconciles the existing VM before progressing. App restart restores the binding and checks reachability.
- **Work item** — Accepted → Running. A phase may wait for input or approval, block, retry, or end according to the validated workflow. Terminal outcomes preserve history. A failed QA result goes to rework when the workflow permits it. A pending QA result waits.
- **Release effect** — Pending → Dispatching → Confirmed or Uncertain. Reconcile uncertain outcomes by operation key before retrying. A verified receipt and post-deployment evidence allow completion.
- **QA run** — Scenario rows progress from queued or running to Passed, Failed, Blocked, or Not Run. Final evidence has one result per required scenario with exact Candidate, Change Brief, Test Plan, and environment references. Verify counts and compute the pass percentage over all required scenarios. A stale candidate or brief invalidates evidence for release.

Use composite project references in joins and permissions, including callbacks and artifact retrieval. Scope a legacy conversation migration to its existing owner and source group. Check associations before enabling new writes.
