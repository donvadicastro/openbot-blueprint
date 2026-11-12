# OpenBot Blueprint

OpenBot Blueprint is a catalog of reusable definitions for multi-agent project teams. Each **project blueprint** describes the essential agents for a type of work, how they collaborate, which tools and resources they need, where they work, and what evidence is required before the result is considered complete.

The first included blueprint is a **software-development suite** with a Team Lead, Delivery Lead, Product Manager, Business Analyst, Architect, Implementer, Reviewer and Quality Engineer. Security, UX, operations and technical writing specialists are available when needed.

A blueprint provides a strong starting team without treating that team as exhaustive. Projects can add domain specialists, integrations and verification steps while preserving clear ownership and delivery standards.

The catalog and CLI use **TypeScript**. Custom bot implementations can independently use **TypeScript or Python**, with runtime metadata for OpenAI Agents SDK, LangChain or custom frameworks.

## What this project provides

This repository supports authoring, validating, scaffolding and exporting blueprints. Its current capabilities are:

| Capability | What it does |
| --- | --- |
| Blueprint catalog | Organizes reusable teams by project type |
| JSON Schema | Describes the blueprint structure and supports editor completion |
| Structural and semantic validation | Checks definitions, references, agent reachability, workflow dependencies and packaged assets |
| Project scaffolding | Copies a blueprint and its declared assets into a new project directory |
| Bot runtime declarations | Describes built-in, local TypeScript/Python and remote AG-UI bots |
| Typed adapter contract | Defines a future runner boundary for requests, results and cancellation |
| OpenBot tenant export | Generates tenant files for built-in or remote AG-UI coworkers |
| Docker Compose deployment | Prepares the tenant and runs OpenBot's native app, database, worker and computer services |
| Automated checks | Compiles TypeScript, validates the catalog and tests catalog behavior |

**Docker Compose runs the native OpenBot platform.** The catalog declares the team and Compose loads its coworkers. Custom SDK execution, project-specific grants, automatic workflow scheduling, quality-gate evaluation and blueprint budget enforcement require runtime integration.

## Run with Docker Compose

For a blueprint-keyed installation, configure the environment as described below, then run `npm run blueprint -- provision software-development --env-file .env --app-port 3010`. Repeating the command identifies the existing installation. Project VM setup also requires the host provider described in the [Compose guide](docs/docker-compose.md#project-vm-provider-in-development).

Use Docker with Compose v2.20 or later. Configure OpenBot's native environment before startup:

```sh
cp -n .env.example .env
cp -n .env.implementer.example .env.implementer
# Fill platform credentials in .env and the implementer's model/key in .env.implementer.
docker compose config --quiet
docker compose up --build -d
```

Open [OpenBot](http://localhost:3010) after `server` is healthy. Select **Projects** next to **Bots**. Choose **New project**, browse to a folder, and select **Use this folder**. The project holds the folder as a shared artifact. Choose one or more bots when starting a conversation in that project.

The default selects `software-development-custom-bot` with eleven built-in coworkers, including the optional specialists, and a separately provisioned implementer service. The root Compose file provisions `implementer-bot` directly.

For an existing `.env`, merge the new defaults: `BLUEPRINT_DIR=./blueprints/software-development-custom-bot`, `MANAGED_AGENT_AG_UI_URL=http://implementer-bot:4201/ag-ui`, `AGENT_ENDPOINT_ALLOWED_HOSTS=implementer-bot:4201`, and a random `MANAGED_AGENT_TOKEN`. Copying with `-n` preserves existing files.

The bundled Postgres database comes preconfigured for local development at `postgres://openbot:openbot@postgres:5432/openbot`. To customize it, update `DATABASE_URL` and the matching `POSTGRES_*` settings in `.env`. Supply the remaining model credentials, Intelligence project settings, encryption key and service tokens before starting Compose.

The stack includes tenant preparation, PostgreSQL, migrations, OpenBot app/API, the custom `implementer-bot`, routines worker, shared computer and the native supervisor. The implementer reads its own native model settings from `.env.implementer`; the server waits for its health check. The stack builds OpenBot from a pinned source revision and persists data in named volumes. Only the application port is published, on loopback. The supervisor receives the Docker socket to create computer containers.

See [Docker Compose setup](docs/docker-compose.md) for every required setting, startup checks, blueprint selection, lifecycle commands and runtime limitations.

The new business-project initialization and per-project VM integration are under development. See [project VM provider setup](docs/docker-compose.md#project-vm-provider-in-development) for the host requirements and current readiness limitation.

### Use LM Studio for local inference

Start LM Studio’s local server and use the model ID it reports at `/v1/models`. In `.env`, set:

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=<lm-studio-model-id>
OPENAI_BASE_URL=http://host.docker.internal:1234/v1
OPENAI_API_KEY=lm-studio
```

Use the same provider, model and URL in `.env.implementer`, with `OPENAI_API_KEY=` for an unauthenticated server. The built-in OpenBot client needs a nonempty value, so `lm-studio` is a placeholder. If you enabled authentication in LM Studio, use its API token in both files. Apply the settings with `docker compose up -d`. See [local inference setup](docs/docker-compose.md#use-lm-studio-or-another-local-endpoint) and [LM Studio’s endpoint documentation](https://lmstudio.ai/docs/developer/openai-compat).

## Quick start

Requires Node.js 22 or later and npm. The CLI has no runtime package dependencies; development dependencies provide the TypeScript compiler and Node.js types. Catalog operations need no API keys.

```sh
npm ci

# Discover and inspect available blueprints.
npm run blueprint -- list
npm run blueprint -- show software-development

# Compile, validate the catalog and run tests.
npm run check
```

Create a project from the development suite:

```sh
npm run blueprint -- scaffold software-development ./dist/my-product my-product
npm run blueprint -- validate ./dist/my-product/blueprint.json
```

The generated directory contains an editable `blueprint.json`, a local schema copy, agent prompts and any declared local assets. Scaffolding assigns the new ID and a name derived from it, resets the blueprint version to `0.1.0`, and refuses to overwrite an existing directory.

`dist/` is ignored by Git. Use a directory outside `dist/` when you want to keep the generated definition under version control. Scaffolding creates configuration and copies declared files; it does not create an application codebase from a user request.

## What is a blueprint?

A blueprint is a versioned contract for how a project team should handle a request. It connects three kinds of information:

1. **Responsibilities:** who scopes, designs, implements, reviews and verifies the work.
2. **Capabilities:** which tools, resources, bot implementations and isolated environments each role needs.
3. **Delivery rules:** how work is handed off, which dependencies must finish first, what evidence demonstrates quality, and when execution must stop.

A project type such as software development can have a reusable baseline. A particular project instantiates that baseline, binds its repository and resources, and adjusts the team to its domain. A runtime then turns the definition into actual work.

```mermaid
flowchart LR
  B[Reusable project blueprint] --> P[Project-specific definition]
  P --> R[Runtime integration]
  U[User request] --> R
  R --> D[Deliverables and verification evidence]
```

A single blueprint can support many requests. The blueprint defines the team's operating rules; each request supplies its objective, revision, acceptance criteria and task-specific context.

### Blueprint structure

The complete example lives in [blueprints/software-development/blueprint.json](blueprints/software-development/blueprint.json). Its main sections are:

| Section | Purpose |
| --- | --- |
| `schemaVersion`, `id`, `name`, `version`, `projectType`, `description` | Identify the definition and its format |
| `entrypoint` | Identify the team's point of contact |
| `intake` | Customize the starter message and the optional coworker the entrypoint can hand requests to in the bundled OpenBot deployment |
| `inputs`, `outputs` | Describe required context and expected results |
| `agents` | Define roles, prompts, deliverables, capabilities and bot runtimes |
| `connections` | Define directed handoff contracts between agents |
| `tools` | Declare capabilities, transports, access levels and setup requirements |
| `resources` | Describe repositories, requirements, artifact stores and packaged files |
| `environments` | Declare workspace, isolation, network and compute requirements |
| `workflow` | Define stages, ownership, dependencies and failure behavior |
| `qualityGates` | Define acceptance criteria and required evidence |
| `executionPolicy` | Declare concurrency, handoff, rework and time limits |
| `extensionPolicy` | Explain how to add roles while preserving accountability |
| `deployment` | Reference a packaged native OpenBot environment template |
| `extensions` | Hold optional integration-specific metadata |

`schemaVersion` identifies the contract format. Each blueprint tracks its own revision in `version`.

### Agent definitions

An agent defines a responsibility independently of its implementation. For example, this is the development suite's implementer definition:

```json
{
  "id": "implementer",
  "name": "Software Engineer",
  "role": "Implementation",
  "purpose": "Produce focused changes and meaningful implementation evidence.",
  "tier": "core",
  "prompt": "prompts/implementer.md",
  "tools": [
    "repository-read",
    "workspace-edit",
    "test-runner",
    "artifact-write"
  ],
  "resources": ["source", "requirements", "artifacts"],
  "environment": "development",
  "deliverables": [
    "Patch tied to base revision",
    "Test evidence and implementation notes"
  ],
  "runtime": { "kind": "builtin" }
}
```

Prompt paths are relative to the blueprint directory. Tool, resource and environment values reference IDs defined elsewhere in the same blueprint.

A `core` role is part of the recommended baseline. An `optional` role has an `activateWhen` criterion describing when its expertise is needed. The baseline is deliberately extensible: a project can add a database specialist, performance engineer or domain expert with its own instructions, handoff contracts and capabilities.

### Connections and workflows

Connections describe **communication**: who may hand work to whom, the trigger, required inputs, expected outputs and failure response. The development suite connects the lead to each specialist and defines a return path to the lead.

Workflows describe **execution dependencies**: which stage must finish before another begins. The file order is for readability; `dependsOn` defines the dependency graph.

The graphs have different rules. Request/response connections can form cycles. Workflow dependencies must be acyclic. A runner must interpret these contracts, manage assignments and evaluate the resulting evidence.

## Example: the software-development suite

The suite takes a software request from scoped intent to independently reviewed and verified delivery. Its expected inputs are a request, repository and base revision, constraints, available capabilities and execution budget. Its expected outputs are a reviewed patch, reproducible validation evidence and a delivery summary.

### Team and deliverables

| Agent ID | Role | Tier | Main deliverables |
| --- | --- | --- | --- |
| `team-lead` | Team Lead | Core | User-facing request brief, decisions, status and delivery updates |
| `lead` | Delivery Lead | Core | Intake brief, accepted requirements baseline, work assignments and final evidence summary |
| `product-manager` | Product Manager | Core | Business outcomes, prioritized scope and a log of stakeholder decisions and open questions |
| `business-analyst` | Business Analyst | Core | Requirements with stable IDs, workflows, business rules, exceptions and testable acceptance criteria |
| `architect` | Solution Architect | Core | Implementation approach, interface decisions, compatibility risks and verification plan |
| `implementer` | Software Engineer | Core | Focused patch, revision references, check results and implementation notes |
| `reviewer` | Code Reviewer | Core | Independent findings, severity, locations and a verdict for the proposed revision |
| `qa` | Quality Engineer | Core | Acceptance matrix, regression evidence and release-readiness verdict |
| `security` | Security Specialist | Optional | Threat analysis and security findings |
| `ux` | UX Specialist | Optional | Interaction and accessibility acceptance notes |
| `operations` | Operations Specialist | Optional | Rollout, rollback and observability plan |
| `tech-writer` | Technical Writer | Optional | Documentation draft with source references and open questions |

The lead records why an optional specialist was activated and integrates its findings into the relevant delivery gate.

| Specialist | Activation criteria |
| --- | --- |
| Security | Authentication, authorization, sensitive data, dependency trust or externally exposed input changes |
| UX | New or materially changed user-facing workflows, interactions or accessibility requirements |
| Operations | Infrastructure, schema migrations, deployment behavior or operational reliability changes |
| Technical Writer | New or materially changed technical documentation |

Core roles preserve separate implementation, review and verification responsibilities. The amount of work should match the request: a small fix can have a brief design and targeted checks. Any runtime that condenses stages must still account for their gate evidence.

### Set up a request with the Team Lead

The folder picker browses the host directory mounted at `/projects`. By default it uses `./projects` beside the Compose file. Set `PROJECTS_HOST_DIR` in `.env` to point to another directory, then recreate the server and agent computer. The Product Manager starts discovery from the selected folder and follows up in conversation.

Each agent declares its own `readiness` fields:

- **Intake** fields come from the setup form, such as the Software Engineer's project folder.
- **Assignment** fields come from tools or prior work, such as a successful read of the selected revision under the receiving bot's identity or an accepted requirements baseline.

The server saves the artifacts to the private Team Lead thread and requires a complete form before handoff. The Delivery Lead can hand discovery to the Product Manager. For other Bot-to-Bot handoffs, the sender supplies the recipient's declared fields as a JSON object of strings in the native `message_bot` tool's `constraints` parameter. Resource permissions and assignment checks still apply before specialist work. A standalone remote bot owns its own access checks.

### Workflow and quality gates

The Team Lead handles the conversation with the user and hands ready requests to the Delivery Lead. The Delivery Lead owns the workflow below.

```mermaid
flowchart LR
  A[Intake · Lead] --> P[Define scope · Product Manager]
  P --> R[Specify requirements · Business Analyst]
  R --> B[Design · Architect]
  B --> C[Implement · Engineer]
  C --> D[Review · Reviewer]
  D --> E[Verify · QA]
  E --> F[Deliver · Lead]
```

The Delivery Lead routes the Product Manager's brief and decision log to the Business Analyst, brings blocking decisions back through the Team Lead, and passes the accepted requirements baseline to the Architect and QA. A workflow runner must schedule stages and enforce their gates.

| Stage | Gate | Evidence and completion criteria |
| --- | --- | --- |
| Intake | `intake-accepted` | The brief records the requested outcome, constraints and unknowns. The lead assesses specialist triggers. |
| Define product scope | `product-scope-accepted` | The product brief identifies the outcome, affected users and scope priorities. Blocking decisions are resolved. |
| Specify requirements | `requirements-accepted` | The requirements trace to the product brief, cover relevant rules and exceptions, and have testable acceptance criteria. |
| Design | `design-accepted` | Design follows repository conventions and addresses risks, compatibility and verification |
| Implement | `implement-accepted` | Patch addresses the accepted scope; relevant checks and remaining gaps are documented |
| Review | `review-accepted` | Independent review has no unresolved blocking findings and identifies the reviewed revision |
| Verify | `verify-accepted` | QA maps passing acceptance evidence to requirement IDs and resolves consequential verification gaps. |
| Deliver | `deliver-accepted` | Review and QA cover the same final revision; changes, risks and evidence are summarized |

A failed gate returns evidence to the lead for rework. Changes to the candidate revision invalidate dependent approvals. The intended runner behavior is to rerun affected stages and their dependent gates within the execution budget, then report unresolved blockers if that budget is exhausted.

### Tools, resources and compute

The suite declares four capabilities:

| Tool ID | Access | Intended use |
| --- | --- | --- |
| `repository-read` | Read | Inspect repository files, history and diffs through a configured MCP server |
| `workspace-edit` | Write | Change files in the assigned isolated workspace |
| `test-runner` | Execute | Run project checks in a provisioned environment |
| `artifact-write` | Write | Save request-scoped patches, reviews and verification evidence |

The lead and architect use brokered read tools without a dedicated computer. The implementer has a writable development environment. Review and QA have independent candidate-revision checkouts and no source-editing grant.

| Environment | Isolation and resources | Network requirements |
| --- | --- | --- |
| `coordination` | No dedicated compute; brokered tools | No local computer network access |
| `development` | Per-task container/workspace; 2 CPU, 4,096 MB memory | Explicit allowlist for approved package hosts |
| `review` | Independent container/checkouts; 2 CPU, 4,096 MB memory | Disabled; dependencies are preinstalled |

These are provisioning requirements, not containers created by the CLI. Local compute network restrictions are separate from brokered tool access.

Deployment bindings identify the actual project resources:

| Reference | Meaning |
| --- | --- |
| `${PROJECT_REPOSITORY}` | Assigned source repository |
| `${PROJECT_BRIEF_URI}` | Task brief and acceptance criteria |
| `${ARTIFACT_STORE_URI}` | Request-scoped evidence store |
| `REPOSITORY_MCP_URL` | Configured repository MCP endpoint |
| `REPOSITORY_TOKEN` | Deployment-managed credential name |

The catalog preserves placeholders without resolving them or reading credentials. A runtime must bind the resources and enforce the requested access.

### Execution budget

The included suite declares these defaults:

| Limit | Value |
| --- | --- |
| Concurrent agents | 3 |
| Handoffs | 30 |
| Rework cycles | 2 |
| Request timeout | 120 minutes |

On exhaustion, the intended behavior is to stop new delegation, preserve completed evidence and report remaining blockers. The policy also identifies actions requiring authorization beyond the existing request, such as out-of-scope deployment, destructive changes, new spending or privileged access. Enforcement belongs to the runner.

### Walkthrough: add project CSV export

Consider this illustrative request to a runtime using the suite:

> Add CSV export to the project list. Export only projects the signed-in user can access, preserve the current filters, and provide accessible loading and error states. Follow the existing application patterns. Deliver a reviewed patch and verification evidence; deployment is outside this request.

This walkthrough explains the intended collaboration. It is not a recorded run or functionality implemented in this repository.

1. **Lead scopes the request.** Record the starting revision, export fields, filter behavior, permissions and observable acceptance criteria. Activate security because the export crosses an authorization boundary, and UX because it adds a user interaction. Assess operations involvement if the design introduces infrastructure or deployment changes.
2. **Architect inspects existing patterns.** Identify list queries, authorization checks, export conventions and UI components. Specify how the export reuses permission and filter logic, handles data safely and reports failures.
3. **Specialists refine the plan.** Security reviews access boundaries and exported content. UX specifies keyboard access, status announcements and failure recovery. Their findings become inputs to implementation and verification.
4. **Implementer produces the patch.** Work in an isolated checkout, add the export and UI behavior, and run relevant checks. Record the candidate revision and artifact locations.
5. **Reviewer independently checks the candidate.** Inspect authorization enforcement, filter handling, edge cases and maintainability. Return actionable findings or an approval tied to that revision.
6. **QA verifies acceptance.** Exercise permitted and denied access, filtered exports, relevant data edge cases and UI states. Record commands, outcomes, environment and candidate revision.
7. **Lead delivers the evidence.** Confirm review and QA cover the final revision, summarize the changes and limitations, and provide the patch and evidence references.

If review finds that the export can expose another user's projects, the lead returns the work for a fix. The new revision needs renewed review and dependent verification; an approval of the old revision is insufficient.

A runner request can use the typed `BotRequest` shape below. The values are illustrative; the CLI does not accept or execute this request format.

```json
{
  "requestId": "dev-0042",
  "objective": "Add authorized, filter-preserving project CSV export with accessible UI states.",
  "baseRevision": "abc1234",
  "acceptanceCriteria": [
    "Only projects the signed-in user can access are exported.",
    "Current list filters are preserved.",
    "The export action has accessible loading and error states.",
    "Review and acceptance evidence identify the final candidate revision."
  ],
  "artifactPaths": ["requests/dev-0042/brief.md"]
}
```

The suite's prompt guidance asks handoffs to carry the request ID, objective, base revision, acceptance criteria, artifacts, evidence, unresolved risks, next owner and status. The typed adapter contract covers requests and results; a runner can add routing metadata around them.

An example artifact layout for this request is:

```text
requests/dev-0042/
├── brief.md
├── design.md
├── implementation.patch
├── review.md
├── acceptance-matrix.md
├── check-results.txt
└── delivery.md
```

These names are conventions for the example. The blueprint declares required kinds of evidence rather than creating or enforcing these particular files.

## Custom bots in TypeScript or Python

An agent's role and handoff contracts can remain the same when its implementation changes. Set its `runtime` to one of these variants:

| Kind | Description |
| --- | --- |
| `builtin` | Use the hosting platform's built-in coworker implementation; also the default for older definitions without a runtime field |
| `local` | Describe packaged TypeScript or Python source, a framework, dependency manifest and factory export |
| `remote` | Reference an independently deployed service speaking AG-UI |

For a TypeScript implementation, replace the agent's runtime with a declaration such as:

```json
{
  "kind": "local",
  "language": "typescript",
  "framework": "openai-agents",
  "entrypoint": "bots/architect/agent.ts",
  "dependencyFile": "bots/architect/package.json",
  "exportName": "createAgent",
  "files": ["bots/architect/tools.ts"]
}
```

A Python implementation can use:

```json
{
  "kind": "local",
  "language": "python",
  "framework": "langchain",
  "entrypoint": "bots/implementer/agent.py",
  "dependencyFile": "bots/implementer/pyproject.toml",
  "exportName": "create_agent",
  "files": ["bots/implementer/tools.py"]
}
```

These declarations describe code you supply. Both languages accept `openai-agents`, `langchain` and `custom` framework identifiers. The framework is distinct from the model provider: a LangChain bot can use OpenAI models.

Local entrypoints, dependency manifests and additional files must exist inside the blueprint directory. Validation checks language extensions and file containment. Scaffolding copies the declared files, while a runner handles SDK installation, factory loading, isolation, capabilities and execution. The catalog does not discover imports automatically or verify SDK compatibility.

The proposed adapter boundary in [src/types.ts](src/types.ts) includes `BotRuntime`, `BotRequest`, `BotResult` and `BotAdapter`. Python implementations need a bridge and equivalent serialized request/result validation when integrating with a TypeScript runner.

See [Custom bot runtimes](docs/custom-bots.md) for the full contract and remote-service details.

### Packaged example: custom bot on the Docker network

The [custom implementer blueprint](blueprints/software-development-custom-bot/README.md) is provisioned by the default root Compose stack. It includes a working LangGraph service instance, separate model environment template, reference registration override and optional host-port override. It keeps the rest of the development suite built-in.

From the repository root, copy the templates without replacing existing environment files:

```sh
cp -n blueprints/software-development-custom-bot/deployment/.env.example .env
cp -n blueprints/software-development-custom-bot/deployment/implementer.env.example .env.implementer
# Fill platform credentials in .env and the bot's model/key in .env.implementer.
# If .env already existed, merge the custom blueprint selection and token settings.

docker compose up --build -d
docker compose ps implementer-bot
```

OpenBot registers the implementer at `http://implementer-bot:4201/ag-ui` through native `MANAGED_AGENT_AG_UI_URL`. The root Compose file configures the matching `MANAGED_AGENT_TOKEN` on both ends and adds the bot's health dependency. `AGENT_ENDPOINT_ALLOWED_HOSTS=implementer-bot:4201` permits that private endpoint. The service reads its own native `BOT_PROVIDER`, `BOT_MODEL` and provider key from `.env.implementer`. The packaged `compose.custom-bot.yml` remains a reference/compatibility example; it is unnecessary for default startup.

| Access route | Example URL |
| --- | --- |
| Server container to bot container | `http://implementer-bot:4201/ag-ui` |
| Host access with the optional published-port override | `http://localhost:4201/ag-ui` |
| Server container to a bot through the Docker host | `http://host.docker.internal:4201/ag-ui` |
| Remote Docker machine/VM | `http://<reachable-engine-host>:4201/ag-ui` with an appropriately published port |

Inside the server container, `localhost` means that container. Host-routed registration requires changing the endpoint and allowed-host entry; on Linux the host service must listen on a gateway-reachable interface. A remote Docker engine's host is not automatically your laptop. The [example guide](blueprints/software-development-custom-bot/README.md#local-url-versus-the-docker-host) includes the optional port override, host-run bot registration, native authentication and Docker Machine/remote-context details.

## Define an individual bot

An individual custom bot has two configuration layers: its role and capabilities in the blueprint, and its model and execution settings in its own service. The blueprint references the service through an AG-UI endpoint.

### Blueprint definition

Place the following object in your project's `agents` array, replacing the existing `implementer` entry when starting from the development suite:

```json
{
  "id": "implementer",
  "name": "Software Engineer",
  "role": "Implementation",
  "purpose": "Implement scoped changes and provide verification evidence.",
  "tier": "core",
  "prompt": "prompts/implementer.md",
  "tools": [
    "repository-read",
    "workspace-edit",
    "test-runner",
    "artifact-write"
  ],
  "resources": ["source", "requirements", "artifacts"],
  "environment": "development",
  "deliverables": [
    "Implementation patch",
    "Test results",
    "Implementation notes"
  ],
  "runtime": {
    "kind": "remote",
    "protocol": "ag-ui",
    "endpointEnv": "IMPLEMENTER_BOT_URL"
  }
}
```

Tool, resource and environment IDs must reference definitions in the same blueprint. The prompt file must exist relative to the blueprint directory. When adding a new agent ID instead of replacing an existing one, also define connections that make it reachable from the lead and return its results. Optional agents need an `activateWhen` criterion. See [Authoring blueprints](docs/authoring.md) for workflow and gate requirements.

### Service-owned model and execution parameters

The custom service chooses its model and enforces its execution limits. For example, your implementation could read a service-owned `bot.config.json` with this shape:

```json
{
  "provider": "openai",
  "model": "<available-model-id>",
  "generation": {
    "maxOutputTokens": 8000
  },
  "execution": {
    "timeoutSeconds": 300,
    "maxToolCalls": 20
  }
}
```

**This is an illustrative custom-service format, not a supported blueprint configuration field or an implemented loader.** Your TypeScript or Python service must read the file, translate supported generation parameters into SDK options, and enforce timeouts and tool-call limits. Additional parameters depend on the selected model and SDK; do not assume every model accepts the same options. These per-service limits are separate from the blueprint's overall execution budget.

For a packaged `local` implementation, list a service-owned configuration file in `runtime.files` if you want scaffolding to copy it. This packages the file without interpreting it. A local implementation still needs to be deployed as a remote AG-UI service before this Compose stack can use it.

### Credentials, endpoint and instructions

Keep the provider credential in the custom service's own environment, using the variable name its implementation expects. For an OpenAI-backed implementation that reads `OPENAI_API_KEY`:

```dotenv
# Custom bot service environment; do not commit this value.
OPENAI_API_KEY=<your-existing-key>
```

Keep its endpoint reference in OpenBot's root `.env`:

```dotenv
IMPLEMENTER_BOT_URL=https://your-bot.example.com/ag-ui
```

Replace these placeholders with your actual settings. The service must already be deployed and reachable from the OpenBot server container. Configure native `AGENT_ENDPOINT_ALLOWED_HOSTS` for private endpoints when required.

The custom service must load its instructions and implement its granted tools. The export does not transmit the blueprint's prompt file to a remote service, and capability declarations do not create live tool grants. OpenBot's root environment configures OpenBot; it does not automatically configure the model or credentials of another service.

There is currently no first-class per-agent `model`, `generation` or `execution` field in the blueprint agent schema. Keep those settings in the custom implementation. The next section explains how to combine different models across the team and reload the configuration.

## Choose a model per agent

**Yes, through independently configured remote bots.** The current built-in development-suite coworkers share one deployment-wide model. The pinned OpenBot tenant loader and this blueprint schema do not support an agent-level `model` override.

| Agent implementation | Where its model is configured |
| --- | --- |
| Built-in coworker | Shared OpenBot `BOT_PROVIDER` and `BOT_MODEL` settings in the root `.env` |
| Remote AG-UI bot | Its own service configuration and SDK implementation; each service can use a different model or provider |
| Local TypeScript/Python definition | Its implementation chooses the model; deploy it as an AG-UI service before using it in this Compose stack |

### Set the shared model for built-in agents

In the root `.env`, select a provider and an available model ID:

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=<shared-model-id>
OPENAI_API_KEY=<your-existing-key>
```

Replace the placeholders locally. For Anthropic, set `BOT_PROVIDER=anthropic`, an appropriate `BOT_MODEL`, and `ANTHROPIC_API_KEY` instead. All built-in coworkers use this shared configuration. Credentials stay in `.env`, outside the blueprint JSON and prompts.

### Give the architect and implementer different models

Use two custom bot services, each exposing an AG-UI endpoint. For example, the architect service can use a model selected for design work, while the implementer service uses a different model selected for coding.

1. **Configure and deploy the services.** Each implementation selects its own model through its SDK or service environment. The services may use TypeScript or Python and different providers. They must implement their prompts, tools and AG-UI transport. The packaged example above supplies one framework-based implementer; other custom implementations must be supplied separately.
2. **Change the two agent runtime declarations** in your project's `blueprint.json`. Keep their existing roles, prompts, deliverables and capability references. Replace only the `runtime` values, as illustrated by these partial agent entries:

```json
[
  {
    "id": "architect",
    "runtime": {
      "kind": "remote",
      "protocol": "ag-ui",
      "endpointEnv": "ARCHITECT_BOT_URL"
    }
  },
  {
    "id": "implementer",
    "runtime": {
      "kind": "remote",
      "protocol": "ag-ui",
      "endpointEnv": "IMPLEMENTER_BOT_URL"
    }
  }
]
```

3. **Set endpoint references in the root `.env`** to the actual deployed services:

```dotenv
ARCHITECT_BOT_URL=https://architect-bot.example.com/ag-ui
IMPLEMENTER_BOT_URL=https://implementer-bot.example.com/ag-ui
```

These URLs are illustrative, not included or running services. Use addresses reachable from the OpenBot server container. Private endpoints also require OpenBot's native `AGENT_ENDPOINT_ALLOWED_HOSTS` setting. If you add bot services in a Compose override, put them on the agent network and configure their endpoint host names accordingly.

The model settings belong to each remote service. For example, if your services implement OpenBot-style environment names, their separate environment files could contain:

```dotenv
# Architect service environment, provided only to that service.
BOT_PROVIDER=openai
BOT_MODEL=<architect-model-id>
OPENAI_API_KEY=<architect-provider-key>
```

```dotenv
# Implementer service environment, provided only to that service.
BOT_PROVIDER=anthropic
BOT_MODEL=<implementer-model-id>
ANTHROPIC_API_KEY=<implementer-provider-key>
```

Custom services must explicitly read these settings and pass them to their SDK. OpenBot does not send `BOT_MODEL`, provider credentials or the blueprint prompt to a remote service. If an implementation uses other configuration names, use those instead. Avoid putting either remote service's model settings into OpenBot's root `.env` as additional `BOT_MODEL` entries: that file configures the shared built-in model, not individual remote bots.

4. **Validate and reload the selected blueprint.** With `BLUEPRINT_DIR` pointing to your project in the root `.env`:

```sh
npm run blueprint -- validate ./path/to/project/blueprint.json
docker compose run --rm --build blueprint-init
docker compose up -d --force-recreate server worker
```

The initialization step requires the selected endpoint variables to be set and validates their URL syntax. Recreating `server` reloads both its environment and the generated tenant. The remote services must already be running; these commands do not deploy them. Other coworkers remain built-in and continue using the shared model.

Adding `model` to an agent definition currently fails blueprint validation. Writing a model preference in a prompt also does not change the model serving that agent. Per-agent models for built-in coworkers would require explicit support in both the blueprint exporter and the OpenBot runtime.

## Export the development suite to OpenBot

Generate a tenant package using the suite's built-in agents:

```sh
npm run blueprint -- export-openbot software-development ./dist/software-tenant
```

Include optional specialists as available coworkers:

```sh
npm run blueprint -- export-openbot software-development ./dist/full-tenant --include-optional
```

Exporting from a project-specific definition works too:

```sh
npm run blueprint -- export-openbot ./dist/my-product/blueprint.json ./dist/my-product-tenant
```

Each output directory must be new. The generated package contains:

```text
software-tenant/
├── brand.yaml
├── agents.yaml
├── channels.yaml
├── model.yaml
├── knowledge.yaml
├── blueprint.json
├── .env.example
└── INTEGRATION.md
```

The YAML files use JSON syntax, a YAML 1.2 subset. Built-in coworkers receive embedded prompts. Remote coworkers receive AG-UI endpoint references. A single channel permits the exported agents and uses `allowed_groups: [all]`; review that setting for a shared deployment. Knowledge sources start empty.

The generated `.env.example` carries OpenBot's native settings. Set `BOT_PROVIDER`, `BOT_MODEL`, the selected provider key, Intelligence project configuration, database credentials, encryption key and service tokens before startup. Point `TENANT_PACKAGE_DIR` at the exported directory when using an existing deployment. The repository's Compose stack prepares its own tenant volume and sets this path automatically. Follow `INTEGRATION.md` and [Docker Compose setup](docs/docker-compose.md) for the remaining configuration.

Local custom bots must first be implemented and deployed behind compatible AG-UI endpoints, then declared as `remote`. The exporter refuses to replace local implementations with built-in bots. Remote services own their prompts and SDK configuration.

The export writes configuration files; it does not register them with a live deployment. Including optional agents makes them available coworkers but does not implement their activation rules. Delegation, scheduling, quality-gate evaluation, revision tracking and budget enforcement remain runtime responsibilities.

This project's `blueprint.json` is an authoring format. The OpenBot adapter targets the documented tenant YAML layout rather than assuming an `openbot.config.json`, `manifest.json`, `bots/` directory or `subagent_targets` contract. See [OpenBot integration](docs/openbot-integration.md) for primary sources, setup details and compatibility limits.

## Add another project type or extend the suite

To create another catalog entry:

```sh
npm run blueprint -- scaffold software-development ./blueprints/research research
```

Rewrite the project type, responsibilities, prompts, tools, resources, connections and gates for the new domain. For a catalog contribution, change `$schema` to `../../schemas/blueprint.schema.json` and remove the scaffolded local schema copy so the entry uses the shared schema.

To add a specialist to an existing suite:

1. Add an agent with a clear purpose, prompt, deliverables and core/optional tier.
2. For an optional role, define an observable `activateWhen` criterion.
3. Add handoff connections that make the specialist reachable from the lead and return its findings.
4. Reference declared tools, resources and an appropriate environment.
5. Integrate the specialist's findings into the relevant gates; add or update workflow stages when its responsibility is mandatory.
6. Increment the blueprint version and validate the result.

Keep independent implementation, review and verification responsibilities explicit. Integration-specific metadata belongs in `extensions`; those values do not automatically grant capabilities or change execution behavior.

See [Authoring blueprints](docs/authoring.md) for further guidance.

## Validation and CLI reference

| Command after `npm run blueprint --` | Purpose |
| --- | --- |
| `list` | List available catalog entries |
| `show <id\|file>` | Show the agent roster, runtimes and workflow |
| `validate [id\|file]` | Validate one definition, or the full catalog when omitted |
| `scaffold <source> <directory> <new-id>` | Create an editable project from a blueprint |
| `export-openbot <id\|file> <directory> [--include-optional]` | Generate an OpenBot tenant package |
| `--help` | Show command usage |

Validation checks JSON structure, required fields, unknown standard properties, runtime variants, duplicate IDs, referenced tools/resources/environments, entrypoint requirements, agent reachability, optional-agent triggers, workflow cycles, gate use and ownership, and declared file containment.

Prompt and packaged asset paths must remain within their blueprint directory; traversal and symlinks to outside files are rejected. Unknown standard fields fail validation, while `extensions` remains an explicit escape hatch for custom metadata.

Validation establishes configuration consistency. It does not prove prompt quality, verify external services, exercise bot code, evaluate runtime results or demonstrate that a delivery gate passed.

```sh
npm run build
npm run typecheck
npm run validate
npm run blueprint -- validate ./path/to/blueprint.json
npm test
npm run check
```

`npm run check` compiles TypeScript, validates the catalog and runs the test suite. CI installs locked dependencies with `npm ci` and runs the same checks on pushes and pull requests.

## Repository layout

```text
blueprints/
├── software-development-custom-bot/ # Suite plus a custom service and Compose examples
└── software-development/
    ├── blueprint.json
    ├── deployment/.env.example # Native OpenBot configuration template
    └── prompts/
        ├── lead.md
        ├── architect.md
        ├── implementer.md
        ├── reviewer.md
        ├── qa.md
        ├── security.md
        ├── ux.md
        └── operations.md
schemas/
└── blueprint.schema.json
src/
├── types.ts                  # Blueprint and future adapter contracts
├── schema.ts                 # Structural validation
├── blueprints.ts             # Catalog, semantic checks, scaffolding and export
└── openbot-environment.ts    # Native environment preflight
bin/
├── blueprint.ts              # CLI entrypoint
└── openbot-compose.ts        # Preflight and tenant-volume preparation
deploy/openbot/               # Fallback environment template and upstream pin
docker-compose.yml            # Native OpenBot platform
Dockerfile                    # Blueprint initialization image
test/
docs/
├── authoring.md
├── custom-bots.md
├── docker-compose.md
└── openbot-integration.md
```

Build output is written to `dist/`. New blueprints should include actionable prompts, concrete handoff artifacts, tool setup instructions, failure handling and measurable verification evidence.
