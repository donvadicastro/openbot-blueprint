# OpenBot integration

## Verified format

The supplied conversation is a conceptual sketch, not an OpenBot compatibility specification. The adapter follows these primary sources, inspected on October 29, 2026:

- [Configuration](https://github.com/CopilotKit/OpenBot/blob/main/docs/configuration.md): tenant files, environment interpolation, settings and `TENANT_PACKAGE_DIR` resolution.
- [Coworkers](https://github.com/CopilotKit/OpenBot/blob/main/examples/fintech/agents.yaml): built-in agent and prompt fields.
- [Channels](https://github.com/CopilotKit/OpenBot/blob/main/examples/fintech/channels.yaml): permitted agents and allowed groups.
- [Brand](https://github.com/CopilotKit/OpenBot/blob/main/examples/fintech/brand.yaml) and [model](https://github.com/CopilotKit/OpenBot/blob/main/examples/fintech/model.yaml) examples.

Upstream `main` can change. Pin and test the OpenBot version you deploy. Repository tests verify export shape and content; they do not boot OpenBot or prove runtime interoperability.

## Export

```sh
npm run blueprint -- export-openbot software-development ./dist/software-tenant
```

| File | Mapping |
| --- | --- |
| `brand.yaml` | Blueprint ID and product name |
| `agents.yaml` | Core agents as built-in coworkers with embedded prompts, or remote AG-UI coworkers |
| `channels.yaml` | One channel permitting exported agents, available to `all` |
| `model.yaml` | Native `BOT_PROVIDER` and `BOT_MODEL` placeholders; provider-derived credential reference |
| `knowledge.yaml` | Empty sources; no implicit connections |
| `blueprint.json` | Reference metadata, including optional `intake` settings used by the bundled OpenBot build |
| `.env.example` | Native OpenBot environment template and any remote endpoint variables |
| `INTEGRATION.md` | Runtime checklist and adapter boundaries |

Generated YAML uses JSON syntax, a YAML 1.2 subset. Review `allowed_groups` before shared deployment. Add `--include-optional` to make specialists available as coworkers; it does not implement conditional activation.

Local TypeScript/Python runtimes cannot be exported directly. Implement and deploy their bot services with AG-UI support, configure their prompts and tools in the service, then change their runtime declarations to `remote`. The exporter refuses local implementations rather than replacing them with built-in coworkers. See [Custom bot runtimes](custom-bots.md).

## Connect an existing deployment

1. Fill the native settings from `.env.example`: `BOT_PROVIDER`, `BOT_MODEL`, the selected provider API key, Intelligence project settings, database settings, vault encryption key and internal service tokens. The pinned tenant loader supports `openai` and `anthropic`; the credential reference is derived from that provider and is not a plaintext API key.
   Set any remote endpoint variables listed in the exported `.env.example` as well. Their services must already be running, reachable and configured with their own prompts and tools.
2. Set `TENANT_PACKAGE_DIR` to the exported directory's absolute path. Relative paths are resolved from OpenBot's `server/` directory.
3. Configure the database, encryption and Intelligence settings following upstream setup instructions.
4. Provision computers, connect resources, register tools and configure scoped grants. Blueprint declarations do not create live access.
5. Implement delegation, optional-specialist activation, dependency scheduling, gate evaluation, revision tracking, retry limits and stopping conditions in the orchestrator.
6. Validate and start with your pinned OpenBot checkout's documented commands. Exercise a complete request including a failed gate and rework before deployment.

The exporter writes coworker and channel declarations; prompts alone do not enforce runtime policy. Remote services own their instructions and SDK configuration; the exporter does not transmit their blueprint prompts. The repository includes a [Docker Compose stack](docker-compose.md) that validates user-supplied native settings, prepares a tenant volume and runs OpenBot's native services from a pinned revision.

Exported metadata retains prompt paths relative to its source blueprint, while coworker definitions embed the full text. To edit a portable blueprint, use `scaffold` and export from its `blueprint.json`.

Catalog commands do not resolve environment secrets or call agent endpoints. The Compose initializer checks native credential presence and syntax without logging or copying their values; OpenBot resolves its native environment at runtime. Blueprint compute and execution policies still require explicit runtime configuration and enforcement.
