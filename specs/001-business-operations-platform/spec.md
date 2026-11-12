# Feature Specification: Business Operations Platform

**Feature Branch**: `main` (current branch)  
**Created**: 2026-11-07  
**Status**: Draft  
**Input**: Provision business ecosystems from reusable OpenBot blueprints, starting with Software Engineering (SWE). Collect existing artifacts and verify that the provisioned bots are operational before starting the business.

## Overview

Each blueprint has one OpenBot installation in a deployment environment. That installation hosts multiple projects. Each project is a separate business workspace where its people and bots collaborate, use shared knowledge, and track decisions, work, and results. Different blueprints can run in separate installations concurrently on the same host. Software Engineering (SWE) is the first business type.

A blueprint is the declarative model that provisions the workspace. It defines which bots are needed, their specialties and responsibilities, the artifacts they need, and how they collaborate. It also defines the shared vocabulary and the workflows that govern business operations. Each workflow has defined phases. Each bot action has an owner, an input format, an output format, and criteria for a successful result. OpenBot uses validated outcomes to decide which phase comes next. For example, an engineer and QA use the same definition of a Candidate and know how it relates to the requirements and verification evidence.

A business starts by connecting the assets it already has. For Software Engineering, the minimum input is an existing source-code location. The owner can also provide CI/CD links, test and live environments, documentation, and requirements. Each provisioned bot checks its prerequisites using its own access and reports readiness with evidence or a blocker. During initialization of each SWE project, OpenBot uses the blueprint to provision a dedicated virtual machine (VM). The project’s bots use that VM to work on and run their own copy of the source. The business becomes operational once all mandatory inputs are supplied, the project VM is ready, and every bot is ready.

The Team Lead is the user’s primary collaborator for setup and day-to-day work. It uses the project’s existing artifacts and decisions to ask focused follow-up questions about gaps that could change the outcome. It helps the user weigh options, records decisions, and brings in the right specialists for discovery or execution. The product conversation is where the user answers questions and sees progress, evidence, and results.

Each bot has its own persistent memory within a project. It can carry forward relevant lessons and preferences from feedback and revise them when corrected. Bots use this memory alongside their configured skills and authorized MCP tools.

Each bot can present the records it works with as an interactive view in the project conversation. Members can see the current state and outcome at a glance and open the underlying details when needed.

The blueprint defines repeatable processes for common business outcomes. Members describe what they want to accomplish in the Team Lead conversation. The Team Lead identifies the applicable process and coordinates the bots that carry it out. When no published process fits a clear request, it creates a temporary workflow using applicable industry standards or established practices.

## Clarifications

### Session 2026-11-07

- Q: What execution environment does the SWE blueprint provision for each project? → A: One dedicated VM shared by the project’s bots under their role permissions. The VM holds a separate working copy of the source and survives OpenBot app restarts.

- Q: What should the product’s user-facing lead be called, and how should it handle ambiguity? → A: Call it Team Lead. It actively works through consequential uncertainties with the user throughout setup and operations, records the answers, and holds work that depends on an unresolved decision.

- Q: How does a blueprint coordinate bots through a business workflow? → A: Define phases and their allowed transitions, give each bot action a clear responsibility and validated input and output formats, and advance only when its recorded outcome satisfies the transition rules. QA plans and runs the required scenarios for an exact candidate, then returns per-scenario results and an aggregate pass percentage.

- Q: How does a bot adapt to feedback within a project? → A: It updates its own persistent memory from authorized feedback and applies the current guidance in later work for that project, alongside its skills and MCP tools.

- Q: How should the project deliver capabilities such as bot memory? → A: Apply the same reuse rule to every requirement. Prefer supported OpenBot configuration, an existing purpose-built skill, or a maintained open-source component that meets the acceptance criteria. Limit custom changes to verified gaps.

- Q: How should a bot show its domain records in chat? → A: The blueprint defines role-specific interactive views of authorized project records. QA shows live execution progress and an at-a-glance final report with details and evidence on demand.

- Q: What interoperability requirement applies to in-chat visualizations? → A: Use an open protocol with a maintained open-source implementation for visualization data and live updates. AG-UI is the baseline to evaluate.

- Q: How do blueprints, installations, and business projects relate? → A: Each blueprint has one OpenBot installation per deployment environment. Owners create multiple business projects inside that installation. Distinct blueprints can run in separate installations on the same host, and each SWE project gets its own VM during initialization.

- Q: Who chooses the process, and what happens if the blueprint has no match? → A: The Team Lead infers the process from the requested outcome and project context. If no published workflow fits a clear request, it creates a temporary workflow for that work item using applicable industry standards or established practices and runs it under the existing project rules.

- Q: How should OpenBot run and observe business workflows? → A: Prefer supported OpenBot orchestration that meets the reliability and visibility requirements. If it falls short, integrate a maintained workflow framework within the blueprint deployment and keep the project conversation and work item as the user-facing entry points.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Provision and initialize a business (Priority: P1)

As a business owner, I want the blueprint to provision the bots and tell me which existing artifacts to provide. I want each bot to check its own prerequisites and report readiness before I can start operating the business.

**Why this priority**: A provisioned roster becomes operational only when its bots can use the artifacts they depend on.

**Independent Test**: Provision SWE with an existing source folder. Supply accessible and inaccessible inputs, review each bot's readiness report, correct the blocker, and verify that normal work opens only after the VM is ready and all bots report Ready. Covers FR-001 through FR-005 and FR-017 through FR-024.

**Acceptance Scenarios**:

1. **Given** a published SWE blueprint, **When** the owner provisions a product, **Then** OpenBot shows the new project as Initializing, shows its blueprint version and exact bot roster, and identifies the required and recommended initialization artifacts before any operational conversation starts.
2. **Given** an SWE product being initialized, **When** the owner supplies an existing source folder and any available CI/CD links, test and live environment references, documentation, or requirements, **Then** OpenBot stores each supplied input as a typed artifact and identifies any missing mandatory inputs.
3. **Given** the owner submits the initialization inputs, **When** the bots check their prerequisites, **Then** each bot reports Ready or Blocked with the artifacts checked, access evidence or the failure reason, and any action the owner needs to take. A bot with no artifact prerequisite confirms its own readiness.
4. **Given** one bot is Blocked or has yet to report, **When** a member requests normal business work, **Then** OpenBot keeps operations closed and shows which readiness check remains outstanding. The Team Lead remains available for initialization questions and corrections.
5. **Given** the owner corrects an artifact binding, **When** affected bots recheck it and the project VM is ready and all provisioned bots have current Ready reports, **Then** OpenBot marks the business Operational and the Team Lead can delegate business requests.
6. **Given** a blueprint with a handoff to an undefined role, **When** an author attempts to publish it, **Then** OpenBot identifies the invalid reference and keeps that version out of the catalog.
7. **Given** an SWE blueprint that defines a Candidate and QA Evidence, **When** an engineer hands a candidate to QA, **Then** QA receives the blueprint-defined record with its source revision and acceptance criteria references. If a required field is missing or the record is the wrong type, OpenBot returns it for correction before QA begins.
8. **Given** valid source input, **When** VM provisioning or source setup fails, **Then** OpenBot keeps the project in initialization, shows the blocker, and lets the owner retry without creating a second VM for the project.
9. **Given** a source artifact is missing or unusable, **When** the owner opens the setup conversation, **Then** the Team Lead asks for that specific input or correction, explains which readiness check it affects, and uses the owner’s response to continue setup. If only recommended inputs are missing, setup can finish once all readiness conditions are met.

---

### User Story 2 - Work through the product's Team Lead (Priority: P1)

As a product member, I want to work through goals, trade-offs, and decisions with the Team Lead and receive progress and evidence in the product conversation so I can work with the right specialists through one point of contact.

**Why this priority**: The team must turn a request into accountable work using the product's knowledge and each specialist's responsibilities.

**Independent Test**: With an Operational product, ask for an adoption recommendation, then separately request a small change. Leave a consequential scope decision open on the change request. Verify the Team Lead asks about it, independent discovery can proceed, and implementation waits and resumes on the same item after an authorized reply. Covers FR-006 through FR-011 and FR-025 through FR-036.

**Acceptance Scenarios**:

1. **Given** a product with metrics and product direction, **When** a member asks how to improve adoption, **Then** the Team Lead routes discovery to the Product Manager, relays any questions, and returns the recommendation with its evidence.
2. **Given** a request to build a feature, **When** the member confirms the proposed scope and acceptance criteria, **Then** the engineer receives the change brief and source references, and QA receives the resulting candidate and criteria.
3. **Given** a required input or permission is missing, **When** a specialist action is proposed, **Then** the Team Lead identifies the blocker and the next step. Once the business is Operational, missing inputs for a specific action leave other eligible work available unless an initialization prerequisite has become invalid.
4. **Given** work is waiting for a decision, **When** an authorized member returns later and provides that decision, **Then** the existing work item records the decision, resumes the affected work, and retains its history.
5. **Given** a request with a known audience and ambiguous scope, **When** the Team Lead reviews it, **Then** it uses the existing audience information and asks a specific scope question with the impact of the decision. If the answer reveals another consequential gap, the Team Lead asks a follow-up. Independent authorized work can proceed while the affected action waits.
6. **Given** an active work item, **When** a specialist finds a conflict with the agreed criteria, **Then** the Team Lead brings the conflict and its consequences to the user and records the decision before affected work resumes.
7. **Given** a confirmed brief and exact candidate, **When** QA receives the required scenarios, **Then** it records a step-by-step test plan, runs it, and returns results per scenario, a pass percentage, and an overall outcome. A required failure returns the work to implementation, a blocked scenario holds verification, and a passing report permits release preparation when requested.
8. **Given** an active workflow phase, **When** a bot returns a malformed or mismatched output or proposes an undeclared transition, **Then** OpenBot records the reason and does not advance the workflow.

9. **Given** a project member gives QA feedback to include steps to reproduce failures, **When** QA verifies a later feature in the same project after an OpenBot restart, **Then** it uses that guidance in its report alongside its configured skills and authorized MCP tools. If a later correction narrows the guidance to intermittent failures, subsequent reports use the revised guidance.

10. **Given** a QA run is underway, **When** the member views it in chat, **Then** scenario statuses and counts update as execution records arrive, and the member can expand a scenario to inspect its recorded details. When the run finishes, the same view shows the final verdict, pass percentage, counts by outcome, and the next workflow step.

11. **Given** a member asks to add CSV export without naming a process, **When** the Team Lead has enough context to understand the goal, **Then** it selects the published feature-development workflow and starts the applicable phase.
12. **Given** a clear request with no matching workflow, **When** the Team Lead creates a temporary workflow, **Then** it shows the planned phases, responsible bots, and applicable guidance in the conversation and runs the validated plan on the existing work item. If a required capability or permission is unavailable, the affected step remains blocked with a reason.

13. **Given** a workflow is waiting for a decision or encounters a recoverable failure, **When** execution restarts, **Then** the work item shows the last durable phase, the wait or failure reason, and any retry attempts. The run resumes from recorded state when its conditions are met, without repeating completed external effects.

### User Story 3 - Prepare and approve a release (Priority: P2)

As a release approver, I want the team to prepare a verified increment and show me the candidate, target, and evidence before deployment so I can decide what ships.

**Why this priority**: A usable software operations workspace must connect delivery to release readiness and make release authority explicit.

**Independent Test**: Start with a verified candidate, first omit the runbook or target, then supply both and approve the candidate for a disposable staging target. Covers FR-010 through FR-014.

**Acceptance Scenarios**:

1. **Given** QA verified a candidate but the release runbook or target is missing, **When** the member asks to deploy, **Then** OpenBot identifies the missing artifact and records deployment as blocked.
2. **Given** the required release artifacts and matching QA evidence, **When** the Release Engineer prepares the release, **Then** the designated approver can see the exact candidate, target, and evidence and approve or decline.
3. **Given** approval for a candidate and target, **When** the candidate changes, **Then** the new candidate needs its own QA evidence and approval before deployment.
4. **Given** an approved candidate and a successful staging deployment, **When** the Team Lead reports completion, **Then** it includes the target, candidate, and verification result.

### User Story 4 - Reuse blueprints across independent products (Priority: P2)

As a workspace owner, I want to run multiple business projects inside the installation for their shared blueprint so each project has its own workspace, team, and knowledge.

**Why this priority**: Projects can share a blueprint and app while keeping their work and data isolated.

**Independent Test**: Run two projects inside the SWE installation and launch a separate installation from a distinct test blueprint on the same host. Publish a new SWE version, then verify isolation, version pinning, and concurrent operation. Covers FR-001, FR-003, FR-005, FR-015, FR-016, and FR-022 through FR-024.

**Acceptance Scenarios**:

1. **Given** two projects in the SWE installation, **When** a member opens either Team Lead, **Then** it uses that product's roles, conversations, artifacts, and permissions, including when both projects use the same bot definition.
2. **Given** a member has access to one product only, **When** they or a bot acting for them attempt to use the other product's known artifact or conversation reference, **Then** access is denied without disclosing its contents.
3. **Given** an existing product pinned to an earlier blueprint version, **When** an author publishes a new version, **Then** the product retains its version.
4. **Given** a distinct test blueprint with a different roster and artifact vocabulary, **When** it is published and used to create a product, **Then** its Team Lead can carry out one supported request using that blueprint's own rules.
5. **Given** a product with completed work, **When** its owner archives it, **Then** authorized members can still inspect its history and new work requests are refused.
6. **Given** two SWE projects selected the same source folder, **When** authorized bots in one project change and run its working copy, **Then** bots assigned to that project can use the results, the original folder and second project’s working copy remain unchanged, and access to the second project’s VM is denied.
7. **Given** a project VM with local edits and build outputs, **When** the OpenBot app restarts, **Then** the project reconnects to the same VM and authorized bots can use those files and run the project again.

8. **Given** a running SWE installation, **When** the owner creates a second project, **Then** it initializes its own VM and can run alongside the first project in the same app without redeploying it.
9. **Given** an installation already exists for a blueprint, **When** provisioning is requested again for that blueprint in the same environment, **Then** the provisioner identifies the existing installation and does not create a second app. A distinct blueprint can launch its own app on the same host.

The SWE feature workflow uses the following responsibilities and records. Release phases apply when shipping is requested.

| Phase | Responsible bot | Required input | Output |
| --- | --- | --- | --- |
| Intake and clarification | Team Lead | User request, project context, applicable decisions | Request brief or a clarification request with the decision needed |
| Discovery | Product Manager | Request brief and confirmed decisions | Change Brief with scope and identifiable acceptance scenarios with expected behavior |
| Implementation or rework | Software Engineer | Confirmed Change Brief, source baseline, and QA Evidence when revising a failed candidate | Candidate tied to the source revision and Change Brief |
| Verification | QA specialist | Exact Candidate, Change Brief revision, and required acceptance scenarios | Test Plan and QA Evidence |
| Release preparation and deployment | Release Engineer | Candidate, passing QA Evidence, runbook, and target. Deployment also requires approval for the candidate and target. | Release proposal for approval, then deployment and verification evidence |
| Report outcome | Team Lead | Validated workflow status and relevant records | User-facing summary with outcome and evidence references |

### Edge Cases

- If live updates are interrupted, the chat view marks the displayed state as last known and refreshes from the recorded run state when it reconnects.

- When projects or role assignments reuse the same bot definition, each invocation receives only the memory for its own project and assignment.

- Two products can reference the same folder while keeping separate identities, permissions, conversations, work histories, and execution environments.
- If the VM provider cannot allocate capacity for a new project, that project remains Initializing and shows the reason. Existing Operational projects can continue working.
- If a project VM becomes unavailable, OpenBot shows the blocker and pauses new VM-dependent actions until it can reconnect. Execution stays within the project’s assigned VM.
- If a startup artifact changes or loses access, readiness reports that depended on it become stale and new operations pause until the affected bots confirm readiness again. A task-specific artifact that becomes unavailable blocks the actions that need it.
- If the user cannot answer a consequential question, the Team Lead keeps the affected action waiting for a decision and explains what can proceed independently.
- If a specialist is unavailable, the Team Lead reports the affected assignment and preserves completed work and evidence.
- If a conversation or service is interrupted, the work item retains its current state. Repeated submissions or retries of the same action do not duplicate an external effect.
- A rejected approval leaves deployment unexecuted. An uncertain deployment outcome stays unresolved until the team can confirm what happened.
- Archiving a product preserves its history and stops new work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Authorized blueprint authors MUST be able to publish immutable, versioned blueprints declaring the exact role roster and specialties, artifact types and owners, mandatory and recommended initialization inputs, each bot’s operational prerequisites and readiness checks, action-specific prerequisites, permitted handoffs, and completion evidence. Publishing MUST reject invalid or unresolved references.
- **FR-002**: Product owners MUST be able to provision a SWE ecosystem by choosing a published blueprint and entering a name. Initialization MUST require an existing source-code location, selected through the local folder picker in the pilot, and accept any available CI/CD, test environment, live environment, documentation, and requirements references. OpenBot MUST distinguish mandatory inputs from recommended enrichment and allow the owner to correct unusable inputs.
- **FR-003**: Each OpenBot installation MUST be bound to one blueprint identity and support multiple concurrent business projects from that blueprint. Projects MUST be listed separately from the Bots directory. Each project MUST persist independently of conversations and retain its selected version of the installation’s blueprint. Owners MUST be able to add a project without redeploying the app.
- **FR-004**: The first SWE blueprint MUST assign one Team Lead, one Product Manager, one Software Engineer, one QA specialist, and one Release Engineer. Their specialties MUST be visible in the product.
- **FR-005**: Each product MUST support typed artifact records with a source, owner, status, access rules, and revision or verification evidence where available. SWE MUST recognize source code, CI/CD links, test and live environment references, documentation, product direction, requirements, engineering practices, candidate increments, test plans, QA evidence, release runbooks, release targets, deployment evidence, and metrics.
- **FR-006**: Each product MUST offer a conversation with its Team Lead for initialization and, once Operational, business requests. The Team Lead MUST receive the product's blueprint, assigned roles, relevant artifact references, and permitted actions, and return questions and results to the originating conversation.
- **FR-007**: The Team Lead MUST infer the process from the requested outcome and project context without requiring a workflow name from the member. It MUST use an applicable workflow from the pinned blueprint when one fits. If the requested outcome is ambiguous, it MUST ask about the goal or constraints under FR-025 before choosing a workflow or creating a temporary one. The PM MUST be able to ask discovery questions and record decisions and acceptance criteria.
- **FR-008**: Handoffs MUST carry the task, assignee, product, expected result, relevant artifact revisions, and applicable limits. OpenBot MUST check delegation permission, required artifacts, and access evidence before the receiving role acts.
- **FR-009**: Each accepted request MUST have a persistent work item showing its workflow phase, status, current assignee, blockers, decisions, and evidence. Follow-up decisions MUST resume the existing item.
- **FR-010**: Engineering MUST be able to produce a candidate linked to the agreed requirements and source baseline. QA MUST verify the exact candidate against its Change Brief and return structured QA Evidence as defined in FR-028.
- **FR-011**: After initialization, missing or stale action-specific artifacts MUST block the actions requiring them. OpenBot MUST identify the affected action and the artifact or permission needed to proceed. Invalidated initialization readiness follows FR-019.
- **FR-012**: Release preparation MUST identify the candidate, matching QA evidence, runbook, target, and designated approver. OpenBot MUST check them before deployment.
- **FR-013**: Deployment MUST require approval for the exact candidate and target. A changed candidate or target MUST require fresh approval and any verification applicable to the change.
- **FR-014**: OpenBot MUST record deployment and post-deployment verification evidence before reporting a release complete. Duplicate attempts of the same approved action MUST preserve a single external outcome.
- **FR-015**: OpenBot MUST enforce product membership and scoped permissions on conversations, artifacts, handoffs, and tool actions. It MUST deny access across product boundaries unless the actor is authorized for the target product. Archiving MUST preserve history and prevent new work.
- **FR-016**: A later blueprint MUST be able to define its own roles, artifacts, handoffs, and completion rules and provision its own installation using the same OpenBot runtime and provisioning approach.

- **FR-017**: After inputs are submitted, each provisioned bot MUST check its declared startup prerequisites using its own product-scoped access. OpenBot MUST record a readiness report for each bot with its status, input revisions checked, evidence or reason, and timestamp. Missing inputs, denied access, failed checks, and absent responses MUST leave that bot unready.
- **FR-018**: OpenBot MUST prevent operational delegation, execution, and release while initialization is incomplete. The business becomes Operational only when all mandatory initialization artifacts are supplied, the execution workspace required by the blueprint is ready, and every provisioned bot has a current Ready report. The Team Lead MUST summarize readiness, ask the owner for specific missing or unusable inputs, and show which checks they affect.
- **FR-019**: OpenBot MUST invalidate readiness reports affected by a changed or inaccessible startup artifact or a changed bot assignment. It MUST suspend new operational work until the affected bots recheck their prerequisites and report Ready. Unaffected reports remain valid.
- **FR-020**: The blueprint MUST be a declarative model that defines the business's shared vocabulary. Each data type MUST declare its purpose, fields, required values, valid states, and relationships to other types where applicable. The model MUST identify which roles produce and consume each type. People and bots working in a product MUST have access to the definitions from its pinned blueprint version, subject to their product permissions.
- **FR-021**: The blueprint MUST declare the record types accepted and produced by each action and exchanged in each handoff. OpenBot MUST validate exchanged records against those definitions, reject incompatible or incomplete records with the reason, and retain links to the exact revisions exchanged.

- **FR-022**: Blueprints MUST declare any execution workspace they require. Each SWE project MUST provision exactly one dedicated VM during project initialization and prepare a writable working copy from the selected source. VM setup failures MUST appear as initialization blockers. Retrying setup MUST preserve the one-VM-per-project binding. A provisioning failure for one project MUST leave other Operational projects able to continue.
- **FR-023**: Every bot assigned to a SWE project MUST be able to use that project’s VM under its role and tool permissions. Local execution and edits MUST stay within the assigned VM and MUST leave the original source and other projects’ workspaces unchanged. External actions such as release remain subject to their own authorization and approval rules.
- **FR-024**: OpenBot app restarts MUST preserve the project’s VM identity, working files, configuration, and build outputs. OpenBot MUST reconnect to the same VM after restart. If it cannot reconnect, it MUST show the blocker and hold VM-dependent work until access returns.

- **FR-025**: During setup and throughout operations, the Team Lead MUST use available project context and prior decisions to identify unresolved questions that could materially change readiness, the outcome, scope, acceptance criteria, constraints, or authorization. It MUST ask targeted questions in the product conversation, explain why the answer matters, and offer options or a recommendation when supported by evidence. It MUST follow up when answers or specialist findings reveal a new consequential gap. OpenBot MUST record questions, decisions, and any stated assumptions against setup or the relevant work item. An action that depends on an unresolved consequential decision MUST wait for an authorized answer. Independent authorized work may continue. A low-impact, reversible assumption may be used if stated. Existing readiness, permission, and approval rules apply.

- **FR-026**: For each supported business workflow, the published blueprint MUST define its start and terminal phases, each phase’s responsible role and actions, required inputs, output format and completion criteria, and allowed transitions with their conditions. Each action MUST declare the result statuses it supports, such as Succeeded, Needs Input, Blocked, and Failed, and the required fields and evidence for each status. Blueprint publication MUST reject missing references and transition rules that could select conflicting next phases for the same recorded outcome.
- **FR-027**: OpenBot MUST enforce the pinned blueprint’s workflow rules. It MUST validate inputs before dispatch and validate outputs, evidence, and transition conditions before advancing. A bot reporting success does not by itself satisfy the completion criteria. OpenBot MUST record the current phase, assigned role, input and output revisions, status, and transition history. Invalid or stale results MUST leave the phase unchanged with a reason. A resumed or repeated result MUST NOT cause the same transition twice.
- **FR-028**: QA MUST receive the exact Candidate and Change Brief revisions with a nonempty set of required scenarios, each with a stable ID and expected behavior. QA MUST produce a Test Plan with prerequisites, ordered steps, and expected results for each scenario, then execute the plan against that candidate. QA Evidence MUST reference the candidate, brief, plan, and test environment and report exactly one result per required scenario with status Passed, Failed, Blocked, or Not Run, plus observed behavior or a reason and evidence where applicable. OpenBot MUST verify the reported counts and pass percentage against the result records. Pass percentage is passed scenarios divided by all required scenarios, multiplied by 100. The report also MUST state the overall outcome. All required scenarios passing permits the next eligible phase. Any failed scenario routes to rework. If there are no failures but a scenario is blocked or not run, verification remains pending. A changed candidate or Change Brief requires fresh verification before release.

- **FR-029**: OpenBot MUST give each bot assignment its own memory within its project. The bot MUST be able to reuse relevant entries across work items, conversations, and OpenBot restarts. OpenBot MUST enforce the project and assignment boundary when reading or writing memory, including when assignments share a runtime bot.
- **FR-030**: A bot MUST be able to add or revise durable guidance from feedback that the project permits it to use. Each update MUST record the feedback source and time. An explicit correction MUST supersede the guidance it replaces while retaining a revision history. When feedback conflicts and the applicable guidance is unclear, the bot MUST request clarification before treating either version as current.
- **FR-031**: A bot MUST be able to use its memory alongside its configured skills and authorized MCP tools. Memory supplies context within the bot’s existing authority. Blueprint workflow rules, required evidence, tool permissions, and approvals MUST continue to govern actions and transitions.

- **FR-032**: A published blueprint MUST declare an in-chat domain view for each bot role. Each view MUST identify the role’s record types, the summary fields, and the details a member can open. For SWE, the Team Lead shows work and pending decisions, the Product Manager shows Change Briefs and acceptance scenarios, Engineering shows candidates and their revisions, QA shows test runs and evidence, and Release Engineering shows release targets, approval state, and deployment evidence. OpenBot MUST render these views in the originating project conversation with the bot role and work item identified. All summary fields, drill-down details, and evidence links MUST respect the viewer’s project and artifact permissions.
- **FR-033**: The QA view MUST show the exact candidate under test and update in place as recorded scenario states change, without requiring a new message or manual refresh. While running, it MUST show completed versus total required scenarios and distinguish queued, running, passed, failed, and blocked work. On completion, the view MUST show the overall verdict, pass percentage per FR-028, counts for each final scenario status, and the resulting workflow state or next action before any drill-down. Members MUST be able to expand individual scenarios to inspect the available planned steps, expected and observed results, and authorized evidence. The conversation MUST reopen the recorded view for the same run, including the final report once available.

- **FR-034**: The blueprint MUST define common business processes as workflows and describe which outcomes and conditions each covers. In SWE, feature development MUST cover discovery and acceptance criteria, implementation, QA and rework, plus release preparation, approval, deployment, and verification when shipping is requested. Each phase MUST declare its participating bot roles and follow FR-026.
- **FR-035**: If no published workflow fits a sufficiently clear request, the Team Lead MUST create a temporary workflow for that work item using applicable industry standards or established practices and project constraints. It MUST record the guidance used, the phases, participating roles, and completion evidence. OpenBot MUST validate the plan against the same workflow rules, declared roles and actions, permissions, and applicable approval requirements before execution. If the plan cannot meet those rules, the Team Lead MUST surface the blocker. OpenBot MUST retain the validated plan with the work item for resumption and audit. Publishing it for future requests requires the normal blueprint publication process.

- **FR-036**: Published and temporary workflows MUST have durable execution state and an inspectable history correlated to the OpenBot work item. Authorized operators MUST be able to see the current phase, attempt history, timestamps, and the reason for a wait, failure, or retry. Runs MUST resume after interruption with their pinned workflow, pending decisions, and prior results intact. Retries MUST respect the action’s retry policy and preserve a single external outcome. If an external outcome is uncertain, reconcile it before retrying.

### Delivery Constraints

- **DC-001**: For each capability, including bot memory, the delivery plan MUST choose the smallest maintainable change that satisfies its acceptance criteria. Evaluate supported OpenBot configuration and existing project tools first. Evaluate purpose-built skills and maintained open-source components through supported extension points for remaining needs. A skill can cover the full capability or work with an existing service that enforces the required behavior.
- **DC-002**: The delivery plan MUST map every capability to its proposed reuse or extension path and the acceptance checks that verify it. For any custom code, custom skill, upstream modification, or new service, record the specific uncovered behavior, the evidence that reuse options leave a gap, and why the proposed change is the smallest maintainable way to close it.
- **DC-003**: The pilot MUST identify required dependencies, their licenses, and their self-hosting options. A required dependency without a verified open-source path MUST be disclosed and explicitly accepted before it becomes a pilot requirement.

- **DC-004**: In-chat domain views MUST use a documented open protocol with a maintained open-source implementation for structured state and live updates. Evaluate AG-UI first and reuse supported OpenBot integration where it meets FR-032 and FR-033. The plan MUST identify the protocol and version and verify conformance for initial state, live updates, and resynchronization on reconnect using the QA run in SC-012.

- **DC-005**: Docker provisioning MUST provision at most one OpenBot installation per blueprint identity in a deployment environment, across blueprint versions. Repeated provisioning for that identity MUST identify the existing installation. Installations for distinct blueprints MUST be able to run concurrently on the same host, each with its own deployment identity, app endpoint, and isolated configuration, networking, and persistent state. Starting, stopping, or restarting one installation MUST preserve the availability and data of the others.

- **DC-006**: Planning MUST evaluate supported OpenBot orchestration first against SC-014. If it cannot satisfy the checks with minimal integration, the blueprint deployment MUST include a maintained workflow framework using the reuse and licensing rules in DC-001 through DC-003. Prefer built-in execution history, persistence, and retry features. OpenBot remains the user-facing entry point and enforces project permissions and approvals for either execution path.

### Key Entities

- **Blueprint Version** — A published operating contract that products reference.
- **Business Data Type** — A blueprint-defined term with a meaning, fields, valid states, and relationships that lets participants interpret and exchange the same business records.
- **OpenBot Installation** — An independently deployed app bound to one blueprint identity that hosts its business projects.
- **Product** — A persistent workspace with members, permissions, bot assignments, artifacts, conversations, and work items.
- **Project VM** — A persistent execution environment provisioned during one SWE project’s initialization. Each initialized SWE project has one VM, and a VM belongs to only one project. It holds a working copy of the source and has a readiness state.
- **Initialization and Readiness Report** — The business setup state and each bot’s recorded check of the startup artifacts and access it needs to operate.
- **Bot Memory** — Persistent guidance owned by one bot assignment within a project, with feedback references and a history of revisions.
- **Bot Assignment** — A bot acting in a blueprint role within one product.
- **Team Lead** — The blueprint-designated bot that collaborates with users, coordinates specialists, and tracks open questions and confirmed decisions in the product conversation.
- **Artifact Type and Artifact Record** — A blueprint-defined vocabulary and a product's instance of it. A record holds its reference, owner, access rules, status, and evidence about its revision or verification.
- **Conversation** — A product-scoped place where a member works with the team.
- **Chat Domain View** — A blueprint-defined presentation of a role’s project records, with summary fields and details members can open in chat.
- **Temporary Workflow** — A validated workflow created for one work item from established domain guidance and the project’s permitted roles and actions. It is retained with the work item and leaves the published blueprint intact.
- **Workflow Definition and Run** — The versioned phases, action contracts, and transition rules, and a work item’s recorded progress through them.
- **Test Plan and QA Evidence** — The steps and expected results for a candidate’s required scenarios, and the matching execution results, pass percentage, and overall outcome.
- **Work Item and Handoff** — The durable request and its assignments, decisions, blockers, and evidence.
- **Approval and Release Record** — An approver's decision for an exact candidate and target, and the resulting deployment and verification outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 4 of 5 pilot owners provision a SWE product from an accessible folder, submit its initialization inputs, and locate the per-bot readiness results within 5 minutes without assistance.
- **SC-002**: In a pilot scenario, a product recommendation reaches the PM and a separate change request reaches engineering and QA. Each ends with a visible outcome and supporting evidence.
- **SC-003**: A staging trial completes one approved release and blocks every tested attempt with a missing runbook, missing target, failed QA, missing approval, or changed candidate.
- **SC-004**: Run two SWE projects concurrently in one installation with distinct VMs. Verify that repeated provisioning for the SWE blueprint leaves exactly one SWE app. Run a distinct blueprint installation on the same host and verify it remains reachable with its data intact when the SWE app restarts or stops. Verify that all tested unauthorized cross-project and cross-installation access attempts are denied.
- **SC-005**: A request waiting for approval resumes after an interruption, with the original work history and a single recorded deployment outcome.

- **SC-006**: In the initialization test, every provisioned bot returns an attributable readiness report. Every attempt to start normal work while a bot is blocked, missing a report, or has stale readiness is refused. The same request can start once the blocker is fixed and all reports are current and Ready.
- **SC-007**: In the SWE pilot, the PM, engineer, and QA exchange a Change Brief, Candidate, and QA Evidence using the same blueprint definitions. Every test handoff with a wrong record type, missing required field, or invalid reference is returned for correction before work starts.
- **SC-008**: In the pilot, create two SWE projects in one installation using the same source folder and run the first project from its VM. Verify that an authorized bot in the same project can use a local edit and build output after an OpenBot app restart, that the VM identity is unchanged, and that both the source folder and second project’s working copy are unchanged. Deny every tested cross-project VM access attempt.

- **SC-009**: In the pilot, test an unusable startup input, a request with unresolved scope, and a new conflict raised by a specialist. In each case, verify that the Team Lead asks a question specific to the gap, reuses available answers, and records the user’s decision. Every tested action that depends on an unanswered consequential question waits, and an authorized answer resumes it on the same setup or work record.

- **SC-010**: Run a SWE feature workflow with four required QA scenarios. Verify that three passes and one failure report 75% and route to rework, three passes and one blocked scenario report 75% and hold verification, and four passes report 100% and permit the next eligible phase. Verify that a missing or duplicate scenario result, an incorrect aggregate, or a report tied to an earlier candidate cannot advance the workflow.

- **SC-011**: Give one QA assignment a reporting preference, restart OpenBot, and verify that a new work item uses the preference and can still use a configured skill and authorized MCP tool. Correct the preference and verify that later work uses the replacement. Verify that another bot assignment in the project and the same bot definition running in another project do not receive the stored guidance. Verify that feedback asking QA to bypass a required check does not let the workflow advance without the required evidence.

- **SC-012**: Open a feature verification in the project conversation and record a scenario starting, passing, and another failing. Verify that the same view updates without manual refresh, the final summary matches QA Evidence and shows the rework outcome before any expansion, and a member can open scenario details and permitted evidence. Interrupt and reconnect the live view and verify that it resynchronizes to the recorded state. Reopen the conversation and verify the same final report is available. Verify that a restricted viewer cannot see protected details and that a different role displays its own domain records in chat.

- **SC-013**: Submit a natural-language feature request and a clear request with no matching published workflow without supplying workflow names. Verify that the first uses the published feature workflow and the second uses a validated temporary workflow with recorded guidance, roles, and completion criteria. Restart OpenBot and verify the temporary run resumes from its saved plan. Verify that a temporary plan with an unavailable role or an omitted mandatory approval cannot execute the affected action and that the published workflow catalog remains unchanged.

- **SC-014**: Run both a published and a temporary workflow through the proposed orchestration path. Interrupt execution while waiting for a decision and after an external effect whose result has not yet been recorded. Verify that authorized operators can trace the phase, wait or failure reason, and retry attempts from the work item. Verify that the pending decision survives, the workflow resumes with the pinned definition, and the external effect occurs only once.

## Assumptions

- The first pilot uses local source folders and a disposable staging target. Hosted source sign-in and production deployment integrations are outside the pilot.
- The product owner manages setup and membership. Authorized product members submit requests, and a designated human approves releases.
- The SWE blueprint requires an existing source-code location as the minimum input. Other available assets can be supplied during initialization. A recommended asset becomes a startup blocker only when the blueprint declares it as a bot’s operational prerequisite. Work-specific evidence such as a candidate build is produced during operations.
- The SWE blueprint requires one VM per initialized project. Other blueprint types declare their own execution workspace needs. The pilot verifies concurrent projects within available VM capacity.
- A distinct test blueprint proves reuse in this feature. A second business domain rollout is outside the pilot.
- Existing authentication and bot availability are prerequisites for the pilot. The companion architecture plan covers platform choices and integration details.
