# Custom bot runtimes

The catalog uses TypeScript, while each bot can use TypeScript or Python. Blueprint definitions remain language-independent JSON. The runtime contract describes implementations and their deployment requirements without coupling the catalog to provider SDKs.

This is authoring, validation, scaffolding and export support. SDK adapters and a bot execution engine are not implemented here. Catalog commands never import bot modules, install their dependencies or run their code.

## Built-in coworkers

```json
{
  "kind": "builtin"
}
```

Set this as an agent's `runtime` to use the hosting platform's built-in coworker implementation. The software-development blueprint uses this for all agents. Omitted runtimes have the same meaning for backward compatibility.

## Local TypeScript implementation

```json
{
  "kind": "local",
  "language": "typescript",
  "framework": "openai-agents",
  "entrypoint": "bots/architect/agent.ts",
  "dependencyFile": "bots/architect/package.json",
  "exportName": "createAgent",
  "files": [
    "bots/architect/tools.ts",
    "bots/architect/package-lock.json",
    "bots/architect/tsconfig.json"
  ]
}
```

This example describes an implementation you provide. `exportName` names the intended factory export; the catalog does not load or verify that symbol. `framework` describes the harness rather than the model provider. A LangChain implementation can also use OpenAI models.

## Local Python implementation

```json
{
  "kind": "local",
  "language": "python",
  "framework": "langchain",
  "entrypoint": "bots/implementer/agent.py",
  "dependencyFile": "bots/implementer/pyproject.toml",
  "exportName": "create_agent",
  "files": [
    "bots/implementer/tools.py",
    "bots/implementer/uv.lock"
  ]
}
```

Both languages accept `openai-agents`, `langchain` and `custom` framework identifiers. TypeScript entrypoints must end in `.ts`, `.mts` or `.cts`; Python entrypoints must end in `.py`. File paths are relative to the containing blueprint directory. The entrypoint, dependency file and additional files must exist, contain text and stay within that directory.

Scaffolding copies these declared assets alongside prompts and packaged resources. List imported source files, configuration and lockfiles in `files`; dependency discovery is not automatic. The catalog does not validate dependency manifest syntax or SDK compatibility. Keep secret values in deployment-managed credentials rather than packaged files.

## Remote bots

A complete local deployment example is included in the [custom implementer blueprint](../blueprints/software-development-custom-bot/README.md). The root Compose stack provisions its pinned LangGraph implementer by default, with a separate model environment file, native endpoint/token registration and optional host access. Its deployment assets are copied by scaffolding and export.

```json
{
  "kind": "remote",
  "protocol": "ag-ui",
  "endpointEnv": "IMPLEMENTER_BOT_URL"
}
```

A remote service can be implemented in either language. Its HTTP/streaming protocol determines interoperability, not its programming language. AG-UI is the currently supported export protocol; an arbitrary JSON HTTP endpoint is not sufficient.

OpenBot export maps this to `type: remote-ag-ui` and `endpoint: ${IMPLEMENTER_BOT_URL}`. It lists the variable in `.env.example` without resolving or contacting it. Deploy the service and configure its instructions, tools, authentication and network reachability separately. The blueprint prompt is not sent to a remote service by the exporter.

## Typed adapter boundary

[src/types.ts](../src/types.ts) defines `BotRuntime`, `BotRequest`, `BotResult` and `BotAdapter`. The adapter's proposed execution boundary is:

```ts
execute(
  agent: Agent,
  request: BotRequest,
  signal: AbortSignal
): Promise<BotResult>
```

Requests carry objective, revision, acceptance criteria and artifact paths. Results carry status, summary, evidence, artifacts and remaining risks. TypeScript adapters can implement this interface directly. A Python adapter would need a transport bridge and equivalent serialized request/result validation; TypeScript types alone cannot validate Python output.

A future runner must select the adapter, pass scoped capabilities, provision isolation, handle cancellation and timeouts, validate results, and enforce workflow gates and budgets. A factory name or framework declaration alone implements none of those behaviors.

Local bots cannot be exported to OpenBot as built-in coworkers. Deploy them with a compatible AG-UI service and change their declarations to `remote` before export. This preserves the chosen custom implementation.

## Project context for framework bots

The OpenBot callback accepts `project_context`, `project_memory`, and
`project_artifacts` with empty argument objects, and `project_artifact_read`
with an artifact ID and optional revision, when a custom bot runs in a project
conversation. OpenBot
derives the project and assignment from the verified bot token and signed run
thread; the bot cannot select a project or assignment in the tool arguments.
`project_memory` returns only guidance for that assignment that the person can
access. A run without a unique project and assignment is refused. These
context callbacks are read-only; they do not grant workspace, release, or workflow
permissions. A custom service must explicitly call the callback with its
native OpenBot credentials and run assertion. Built-in bots are offered these
tools in their project conversation and access is rechecked on each call.
The assigned Team Lead can also call `project_workflows` with empty arguments
to discover the pinned blueprint's published workflows and intended outcomes.
The list is informational; it does not start or dispatch a workflow.

### Native MCP tools for workflow specialists

Project workflow turns can receive a read-only MCP tool that OpenBot already
registered and granted to the assigned bot. Declare its exact
`serverId/toolName` reference on the blueprint tool, and bind every MCP
argument that selects a resource to a JSON Pointer in an artifact input for
that phase:

```json
{
  "id": "repository-read",
  "transport": "mcp",
  "access": "read",
  "endpointEnv": "REPOSITORY_MCP_URL",
  "nativeRefs": ["github/repository_read_file"],
  "resourceBindings": [
    {
      "argumentPath": "/owner",
      "artifactType": "project-source",
      "payloadPath": "/repository/owner"
    },
    {
      "argumentPath": "/repo",
      "artifactType": "project-source",
      "payloadPath": "/repository/name"
    }
  ]
}
```

Register and configure the MCP server in OpenBot, then grant that exact tool to
the relevant bot. `endpointEnv` documents the service endpoint for blueprint
deployment/export; this runtime integration uses the MCP server configured in
OpenBot. The blueprint does not create OpenBot credentials or grants.
At runtime the project runner filters OpenBot's grants to the references
declared by the assigned bot. Each invocation rechecks the active project,
phase, role, supplied visible artifact revision, and exact resource arguments;
unmatched or unbound tools are refused. Only tools declared `access: "read"`
with at least one artifact binding are eligible. Write and execute MCP tools,
handoffs, and tools granted to other bots are not exposed to the project
workflow turn. If no exact OpenBot grant exists, the specialist receives no
MCP tool.
The Team Lead can call `project_prepare_workflow` with `request` and an
`interpretation` containing exactly one of `workflowId`, `needsClarification`,
or a `temporary` workflow proposal. OpenBot verifies the conversation, the
assigned role and readiness, validates the proposal, and stores a pending
plan. A pending plan has not started; workflow execution is not yet connected.
Delegated bots use their signed source conversation and must hold an active
OpenBot handoff lease. Built-in turns receive a bounded set of the current
authorized feedback with the memory tool; the tool returns the complete set.
Custom services that do not use OpenBot's offered tools must call the callback
themselves.

`project_memory_propose` records feedback from the authenticated person's
actual conversation message. Custom services supply `messageId` and `guidance`;
to correct existing guidance they also supply `entryId` and `expectedRevision`.
If feedback conflicts and its meaning is unclear, set `conflict: true` with
the existing entry and revision, then ask the person to clarify. The conflict
is held out of active guidance and pauses that specialist's workflow actions.
After a new clarification message, supply its `messageId`, the entry and
revision, and the returned `resolveConflictId`. OpenBot verifies the message,
conversation, assignment, and feedback permission and retains revision history.
Built-in bots receive the same tool with the current message selected by the
server. Feedback does not change a bot's permissions or bypass workflow rules.

`project_workspace_run` and `project_workspace_reconcile` are available only
when the workflow dispatcher has bound the bot's native run to an active,
authorized phase. The bot supplies command arguments, while OpenBot determines
the project, assignment, granted tool, and stable operation ID. The dispatcher
does not yet create these bindings, so workspace tools remain unavailable in
the current pilot until workflow action integration is complete.
