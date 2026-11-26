# Run a blueprint with native OpenBot configuration

The Compose stack uses OpenBot's server, worker, supervisor and computer implementations. It builds them from revision `ab9855c19848378c90a806426130d86699cc798c`, recorded in [upstream.json](../deploy/openbot/upstream.json). It adds a small initialization container to validate the native environment and prepare the selected tenant package.

## Configure credentials before startup

Requires Docker with Compose v2.20 or later and a working Docker engine. The initial build downloads OpenBot's dependencies and Chromium; allow time and disk space for those images. Native Node.js installation is unnecessary when using Compose.

```sh
cp -n .env.example .env
cp -n .env.implementer.example .env.implementer
```

Edit `.env` locally and fill the required native settings before starting services:

| Settings | Requirement |
| --- | --- |
| `BOT_PROVIDER`, `BOT_MODEL` | Choose `openai` or `anthropic` and an available model |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Supply the selected provider’s key or use the local endpoint settings below |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` | Optional native endpoint overrides |
| `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL` | Native Intelligence endpoints; managed defaults are in the template |
| `CPK_INTELLIGENCE_API_KEY` or `INTELLIGENCE_API_KEY` | Supply an existing Intelligence project key; the former takes precedence |
| `COPILOTKIT_LICENSE_TOKEN` | Only when required by your self-hosted Intelligence deployment |
| `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `DATABASE_URL` | Preconfigured for the bundled database. Update the settings together to use different credentials |
| `KEY_ENCRYPTION_KEY` | A non-example, base64-encoded 32-byte encryption key |
| `COMPUTER_TOKEN`, `SUPERVISOR_TOKEN`, `AGENT_TOOL_TOKEN`, `WORKER_SHARED_SECRET` | Distinct random internal credentials, each at least 32 characters |
| `MANAGED_AGENT_TOKEN` | Shared native server-to-implementer credential; use a random value of at least 32 characters |
| `WORKFLOW_POSTGRES_PASSWORD`, `WORKFLOW_ACTIVITY_TOKEN`, `WORKFLOW_ENGINE_TOKEN` | Distinct random internal workflow credentials, each at least 32 characters and different from the native service tokens |
| Native OAuth settings | Required when using `OPENBOT_SINGLE_USER=false` |

Fill `.env.implementer` separately with the custom service's native `BOT_PROVIDER`, `BOT_MODEL` and selected provider key. The file is required by the root Compose service and is not automatically created. Its model can differ from the built-in coworkers' shared model. Existing environment files are preserved by `cp -n`; merge the defaults from the templates when updating an existing deployment.

The bundled database defaults to `postgres://openbot:openbot@postgres:5432/openbot` for local development. Compose uses the same defaults when the variables are empty or unset. To change the database name, user, or password, update `POSTGRES_DB`, `POSTGRES_USER`, or `POSTGRES_PASSWORD` in `.env` and set a matching `DATABASE_URL`. Use the raw password in `POSTGRES_PASSWORD` and percent-encode reserved URL characters in `DATABASE_URL`. For an existing database volume, retain its current credentials or rotate them in PostgreSQL before changing `.env`.

Generate your encryption key and each service token locally, for example by running `openssl rand -base64 32` separately for each value. This project neither creates provider keys nor writes credentials into generated tenant files. `.env` is ignored by Git and excluded from the local Docker build context.

The default is a local single-user deployment, with the application bound to `127.0.0.1`. All visitors to that local application are one administrator. Shared deployments require OpenBot's native authentication configuration and appropriate deployment review.

## Use LM Studio or another local endpoint

Start the server in LM Studio’s Developer tab. Use the exact model ID returned by `curl http://localhost:1234/v1/models` on the machine running LM Studio. Choose a model with tool calling support for coworkers that use tools. [LM Studio model endpoint](https://lmstudio.ai/docs/developer/openai-compat/models)

Set the following in the platform’s `.env`:

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=<lm-studio-model-id>
OPENAI_BASE_URL=http://host.docker.internal:1234/v1
OPENAI_API_KEY=lm-studio
```

Set the implementer’s model independently in `.env.implementer`:

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=<lm-studio-model-id>
OPENAI_BASE_URL=http://host.docker.internal:1234/v1
OPENAI_API_KEY=
BOT_RESPONSES_API=false
BOT_REASONING_EFFORT=
```

The pinned built-in client requires a nonempty credential value. `lm-studio` is a placeholder for an unauthenticated endpoint. The implementer accepts a blank key. If LM Studio requires authentication, use its token in both files and send it when querying `/v1/models`. OpenBot checks its stored model credential before the `.env` value, so update any saved credential for that provider when switching an existing deployment. [LM Studio server settings](https://lmstudio.ai/docs/developer/core/server/settings)

Both services resolve `host.docker.internal` to the Docker host. If LM Studio runs on a different machine, use its reachable address and port instead. If the host gateway cannot reach the listener, configure LM Studio to listen on a reachable interface using **Serve on Local Network**. [LM Studio network settings](https://lmstudio.ai/docs/developer/core/server/serve-on-network)

Apply the environment changes with `docker compose up -d`. The database, service tokens, and Intelligence project settings are still required by the platform.

## Start the stack

For a blueprint-keyed installation, use the provision command after completing the environment setup:

```sh
npm ci
npm run blueprint -- provision software-development --env-file .env --app-port 3010
```

The command records one installation identity per blueprint key and reports the existing installation on repeat. The root Compose file includes the private Temporal workflow services and requires `WORKFLOW_POSTGRES_PASSWORD`, `WORKFLOW_ACTIVITY_TOKEN`, and `WORKFLOW_ENGINE_TOKEN` to be values of at least 32 characters, distinct from one another and the native service tokens. Provisioning waits up to five minutes for Compose services to start and health checks to pass, including the private workflow gateway; this does not prove a project workflow has completed. A different blueprint can use a separate environment file and application port. The host-side VM provider must also be configured for that installation as described below. Workflow execution remains under verification; see the [workflow guide](../deploy/workflow/README.md).

```sh
# Checks required Compose substitutions without printing the rendered environment.
docker compose config --quiet

# Build images and start OpenBot, its durable workflow engine, and registered bots.
docker compose up --build -d

# Inspect startup and initialization results.
docker compose ps -a
docker compose ps implementer-bot
docker compose logs blueprint-init
```

Open [http://localhost:3010](http://localhost:3010) when `server` is healthy. The application and API are served from the same origin. Select the software-development channel and start with the Team Lead.

## Project VM provider (in development)

The new business-project initialization uses a host-side Lima provider in addition to Compose. Project commands run as an unprivileged guest user in a private network namespace with loopback only; outbound network access is denied by default. Readiness and workspace actions remain blocked unless the provider verifies that isolation. The existing project interface remains available for blueprints without a business definition.

For development on the verified Apple Silicon host, install Lima, Node.js 22 or later, and Python 3. Python is used for directory-handle-relative source intake so folder snapshots do not follow a path swapped to an outside symlink during traversal. On macOS with Homebrew, run `brew install lima` once and verify `limactl --version` in the shell that starts the provider. Set `PROJECTS_HOST_DIR` in `.env` to the directory containing the folders users may select. A relative path such as `./projects` works when you start the provider from the repository root. Set `WORKSPACE_PROVIDER_TOKEN` to a unique random value of at least 32 characters, and set `WORKSPACE_PROVIDER_INSTALLATION_ID` to the Compose project name (default `openbot-blueprint`). Start the host provider in a separate terminal from the repository root:

```sh
npm ci
npm run build
set -a
. ./.env
set +a
export BLUEPRINT_INSTALLATION_ID="${WORKSPACE_PROVIDER_INSTALLATION_ID:-openbot-blueprint}"
node dist/deploy/workspace-provider/server.js
```

Keep that process running while initializing projects. The app reaches its loopback listener at `host.docker.internal:4511` by default; the provider creates a persistent guest for each project and imports a copy of the selected source. Restarting the provider does not delete the VMs. VM networking and Linux support still need their full isolation verification before production use. The provider uses the same token as the server; do not expose its listener publicly.

### Optional SWE workspace readiness pilot

To provision a disposable sample project without waiting for a person to select a folder in the UI, create a self-contained sample under `PROJECTS_HOST_DIR` and run the optional provisioner. It creates one project with the five software-development roles (Team Lead, Product Manager, Engineer, QA, Release), supplies source plus local CI, test-environment, requirements and documentation references, initializes its persistent VM, and requests the blueprint's real per-role readiness checks. It does not create readiness records or run the feature-delivery/QA workflow. A project reaches Operational only when the VM, source and all five current bot reports pass.

From the repository root, with the host provider already running and the Compose server healthy:

```sh
mkdir -p projects/openbot-workspace-readiness-smoke
cp -R examples/swe-readiness-smoke/. projects/openbot-workspace-readiness-smoke/
npm run provision:workspace -- --source /projects/openbot-workspace-readiness-smoke --name 'SWE Workspace Readiness Smoke'
```

The provisioner is idempotent for the same project name and source path. It prints the project ID, state, role statuses and blockers, and exits with status 2 when the project remains Initializing. This supports setup checks; it is not a substitute for the timed owner trial or full product workflow acceptance.

Keep `LIMA_HOME` stable across restarts: changing it points the provider at a different collection of VM disks. When the source folder changes, the previous guest workspace is retained under `~/.openbot/backups/` inside that VM. If an action loses its connection, retrying its same operation key reconciles a completed guest receipt; when no receipt exists, the result remains uncertain and is not automatically repeated. See [VM provider verification and recovery](../deploy/workspace-provider/README.md).

The pinned native OpenBot worker does not provide the required durable business workflow and decision-wait behavior. The root Compose stack therefore includes a private Temporal service and worker, while the native routines worker continues to serve native routines. Both `docker compose up` and blueprint provisioning start the same durable-workflow stack. Workflow state uses the persistent `workflow-postgres-data` volume. See [the implementation decisions](../specs/001-business-operations-platform/research.md) and [remaining tasks](../specs/001-business-operations-platform/tasks.md).

`docker compose config --quiet` checks Compose substitutions and syntax. The `blueprint-init` container performs the fuller provider, Intelligence, database, encryption, token, identity and blueprint checks. If it fails, dependent platform services do not start. Missing settings are reported by variable name without printing their values. Presence and syntax checks do not contact providers or prove that credentials are valid.

Avoid sharing output from plain `docker compose config`: its rendered environment can contain credentials.

## Services and data

| Service | Purpose |
| --- | --- |
| `blueprint-init` | Validate the environment and export the selected blueprint into a tenant volume |
| `postgres` | Persist OpenBot data using pgvector PostgreSQL; not published to the host |
| `migrate` | Apply OpenBot's database migrations before the server starts |
| `server` | Serve OpenBot's app/API and load the generated coworkers |
| `implementer-bot` | Run the registered LangGraph implementer with independent native model settings |
| `worker` | Run OpenBot's native routines worker |
| `workflow-postgres` | Persist the private Temporal workflow history |
| `temporal` | Run the durable workflow engine without publishing a host port |
| `workflow-worker` | Schedule project workflow phases and connect to the authenticated OpenBot activity endpoint |
| `agent-computer` | Provide the native shared browser/workspace computer |
| `supervisor` | Provision native person/Bot computer containers on demand |

The default selection is `software-development-custom-bot`, including eleven built-in coworkers and one remote implementer. A plain `docker compose up --build -d` provisions `implementer-bot`. The server waits for its health check and uses matching native managed endpoint/token settings for authenticated calls. Additional computer containers are created on demand according to OpenBot's own settings.

Both development variants show **Projects** beside **Bots**. Each new project holds a selected folder as its source artifact and lists its conversations. Users choose the bots for each new conversation. The server saves project sources and conversation setup in PostgreSQL. It applies the specific Bot-to-Bot grant declared by `intake.handoffTo` and requires saved setup answers before the Team Lead can use it.

The database and worker use a separate internal data network. The server connects to both the data and agent networks. Browser/computer and supervisor ports are not published. Only the supervisor receives the Docker engine socket, as required to create native computer containers; Docker API access is privileged even when the socket mount is marked read-only.

Named volumes preserve the database, generated tenant, shared workspace and browser profiles. Supervisor-created computers and their volumes are managed separately by OpenBot and do not automatically disappear with Compose services.

```sh
docker compose logs -f server worker
docker compose down
```

`down` retains named-volume data. Changing `POSTGRES_PASSWORD` after database initialization does not change the existing database role's password; rotate it through PostgreSQL and update the environment consistently.

## Select a different blueprint

The default [Software Development with a Custom Implementer](../blueprints/software-development-custom-bot/README.md) wires private-network registration, native authentication and a separate bot environment file directly in the root stack. Its guide also explains host URLs and remote Docker machines. The packaged registration override remains compatible, but is not required.

Set `BLUEPRINT_DIR` in `.env` to the host directory containing its `blueprint.json`. Relative directories are resolved from this repository's Compose file. For a scaffolded project, for example:

```dotenv
BLUEPRINT_DIR=./dist/my-product
BLUEPRINT_INCLUDE_OPTIONAL=true
```

The directory is mounted read-only at `/definition`. Its declared prompts, runtime assets and environment template must be present. All selected agents must be built-in or remote AG-UI bots. Local TypeScript/Python runtime declarations require deploying their implementations first and changing them to remote declarations.

Each development blueprint stores its native template in `deployment/.env.example`, referenced by its `deployment` section. Scaffolding copies that file. Real credentials remain in `.env` and `.env.implementer`. The root template matches the custom-bot blueprint; the generic fallback matches the built-in blueprint, with alignment checked by tests. Changing `BLUEPRINT_DIR` changes registered coworkers; it does not remove the root stack's provisioned implementer service.

To regenerate an existing tenant after editing a blueprint, with the platform already built:

```sh
docker compose run --rm --build blueprint-init
docker compose restart server
```

Initialization validates and exports into a staging directory before replacing the previous tenant. Failed preflight checks leave the previous tenant intact. When changing service credentials or other environment values, recreate affected services with `docker compose up --build -d --force-recreate` so they receive the new environment.

## Runtime responsibilities

Compose starts the native platform and loads the team. Configure repository/connector access, per-agent tool grants, computer modes, network policies and project resources in OpenBot. Blueprint compute requirements and handoff definitions do not become enforced grants or schedules merely by exporting them.

The native routines worker schedules OpenBot routines; it does not interpret this repository's workflow graph. Automatic execution of the entire six-stage workflow, conditional specialist activation, evidence evaluation, revision tracking and blueprint budgets still require orchestration integration. The stack enables running and interacting with the coworkers without claiming that those policies are implemented.

For remote bots, set their named endpoint variables in `.env` and configure native `AGENT_ENDPOINT_ALLOWED_HOSTS` when using private endpoints. Those services must already exist, speak AG-UI and have their own credentials, prompts and tools configured. They are not created from metadata by Compose.

## Updating upstream

The build contexts use an immutable OpenBot commit rather than a floating image tag. Update all contexts and [upstream.json](../deploy/openbot/upstream.json) together, review upstream environment/schema changes, and verify the stack before rolling out an update. Tests check that every native build context matches the recorded revision.

Primary references for the pinned source: [native Compose file](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/docker-compose.yml), [environment template](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/.env.example), and [tenant loader](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/server/src/tenant-package.ts).


### Local project folders

Put project folders under `./projects` beside the Compose file, or set `PROJECTS_HOST_DIR` in `.env` to the host directory you want to browse. Run `docker compose up -d server agent-computer` after changing it. Compose mounts the directory at `/projects` with read-only access in both services. Choose **Projects → New project**, browse to a folder, then select **Use this folder** and **Create project**.

The picker lists folders under the configured root for signed-in OpenBot users. Individual bot environments still need their own workspace access where applicable.
