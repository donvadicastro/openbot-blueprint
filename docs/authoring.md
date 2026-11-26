# Authoring a blueprint

Start from the included example:

```sh
npm run blueprint -- scaffold software-development ./blueprints/research research
```

Set `projectType`, `description`, `inputs` and `outputs` for the new domain. Rename agents and rewrite prompts, tools, resources, connections and workflow together. For a catalog contribution, change the scaffolded `$schema` to `../../schemas/blueprint.schema.json` and remove its local schema copy. Standalone projects retain their copied schema.

## Responsibilities and extensions

Choose a core point of contact and specialists covering business requirements, delivery and independent verification. The validator requires a core entrypoint and at least one other core agent. The software example has eight core roles. The Team Lead handles user communication, and the Product Manager and Business Analyst establish the requirements before design, implementation, review and acceptance verification.

Set `intake.welcomeMessage` to display a welcome in the entrypoint's private conversation on the bundled OpenBot home page. Set `intake.handoffTo` when the entrypoint should have a native handoff grant to a connected core agent. Omit `intake` to keep OpenBot's standard home screen.

Set `intake.form` to `true` to open a fresh setup thread and require a completed form before the entrypoint can hand off. Give intake fields a `question` to control their form label, and use `format: "folder"` to require an absolute folder path or `format: "project-source"` to show the mounted project folder picker. Existing saved project sources can contain a folder path or an HTTPS GitHub repository URL. Core bots supply the startup questions. Fields sharing an ID ask for the same artifact. Collect specialist requirements during discovery and check them before assignment. Submitting the form records setup confirmation. Set `intake.discoveryBy` to a connected core bot when the handoff recipient should be able to delegate discovery.

Add a `readiness` list to a bot to declare what it needs before accepting an assignment. Each field has a unique kebab-case `id`, a `stage` of `intake` or `assignment`, and an `instruction`. Use intake fields for details the user can provide. Use assignment fields for artifacts and access checks the team must produce. The exporter includes the active roster's contracts in the Team Lead and Delivery Lead prompts and includes each built-in specialist's own contract in its prompt. The bundled server checks the named fields on Bot-to-Bot handoffs. A remote service must verify its resources and access at execution time.

Core means an essential responsibility, not a demand to run every role on every trivial task. A runner condensing stages must decide how their gate evidence remains satisfied.

Optional agents require `activateWhen`. Use observable criteria such as “schema migration or deployment configuration changes.” Connect the lead to the specialist and define how results return. Every agent must be reachable from the entrypoint.

Choose each agent's `runtime`: `builtin`, `local` (TypeScript or Python), or `remote` (AG-UI). Local bots specify their framework, entrypoint, dependency manifest, factory export and additional files. Validation checks the entrypoint language and asset containment; scaffolding preserves declared code. See [Custom bot runtimes](custom-bots.md). Omitted runtimes remain equivalent to `builtin` for older definitions.

Add specialists rather than treating the roster as exhaustive. Use `extensions` for namespaced integration metadata; its values are opaque and confer no capabilities. Unknown standard fields fail validation.

## Tools, resources and compute

Agents reference tools, resources and environments by ID. These declare requested capabilities; a runtime must provision and enforce them.

- Tools specify transport (`mcp`, `native`, `http`), capabilities, access and setup. MCP entries require an `endpointEnv` name. `credentialEnv` references a deployment secret by name; never store token values.
- Resources specify repository, documentation, artifact-store or local-file requirements. `location` holds a deployment reference; `path` identifies a packaged text asset.
- Environments specify local compute, isolation, workspace and network requirements. `isolation: none` means no dedicated computer. Brokered tools are separate from local compute network restrictions.

The example's `${...}` values are deployment placeholders. The catalog does not interpolate variables or inspect secrets. Prompt and local-resource paths must stay inside the blueprint directory. Absolute paths, traversal outside it and symlinks to outside files are refused. Scaffolding copies declared UTF-8 assets only.

## Workflow and evidence

Each stage specifies a core owner, dependencies, instructions, gates and failure behavior. Every stage needs at least one gate owned by its owner. Gates specify a core owner, criteria, evidence and failure behavior; all gates must be used. Workflow dependencies must be acyclic. Connection graphs can contain request/response cycles.

`dependsOn` determines execution order, independent of file order. A runtime must schedule dependencies and enforce gate results and budgets. A failed review cannot become approval simply because another prompt says to continue.

Use handoff envelopes containing request ID, objective, base revision, acceptance criteria, artifact references, evidence, unresolved risks, next owner and status. Add domain-specific outputs to `deliverables` and connection contracts.

`schemaVersion` identifies the contract (`1.0`); `version` identifies the blueprint (`major.minor.patch`). Change the blueprint version when responsibilities, handoffs, criteria or permissions change. Breaking schema changes require a schema migration plan.

For OpenBot deployment, add `deployment: { "runtime": "openbot", "environmentFile": "deployment/.env.example" }`. The environment file must be a packaged template inside the blueprint directory; scaffolding preserves it and export uses it as `.env.example`. Optional `deployment.files` lists additional Compose overrides, service environment templates and guides to preserve during scaffolding and export. All files must stay inside the blueprint directory. Keep real credentials out of templates. Use native names such as `BOT_PROVIDER`, `BOT_MODEL`, provider keys, Intelligence configuration and internal service tokens. See [Docker Compose deployment](docker-compose.md) and the [custom service blueprint](../blueprints/software-development-custom-bot/README.md).

```sh
npm run blueprint -- validate research
npm run check
```
