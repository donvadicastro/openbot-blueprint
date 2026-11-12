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
