# Development suite with a custom bot service

This blueprint replaces the development suite's built-in implementer with a separate LangGraph AG-UI service. Other roles remain built-in. It demonstrates local registration, independent model configuration, native service authentication and Docker networking.

The example service uses OpenBot's framework bot at the same pinned source revision as the platform. It is a working service instance, not an arbitrary HTTP placeholder. Replace its build with your own TypeScript/Python AG-UI implementation when customizing bot code.

## Start from the repository root

Requires Docker Compose and user-supplied credentials. Copy the templates only if the destination files do not already exist; otherwise merge the settings into your existing files.

```sh
cp -n blueprints/software-development-custom-bot/deployment/.env.example .env
cp -n blueprints/software-development-custom-bot/deployment/implementer.env.example .env.implementer
```

Fill the platform's native credentials in `.env`, including `MANAGED_AGENT_TOKEN`, and the implementer's native provider key and `BOT_MODEL` in `.env.implementer`. No keys are provisioned automatically. If `.env` existed already, set these values explicitly:

```dotenv
BLUEPRINT_DIR=./blueprints/software-development-custom-bot
MANAGED_AGENT_AG_UI_URL=http://implementer-bot:4201/ag-ui
MANAGED_AGENT_TOKEN=<your-random-service-token>
AGENT_ENDPOINT_ALLOWED_HOSTS=implementer-bot:4201
IMPLEMENTER_ENV_FILE=.env.implementer
```

Replace the token placeholder with a random value. The token is shared by OpenBot's server and the bot service, separately from model credentials. The root Compose file configures these native managed endpoint/token settings and provisions implementer-bot by default.

Start from the repository root. No additional Compose file or profile is required:

```sh
docker compose config --quiet

docker compose up --build -d
docker compose ps implementer-bot
```

Open [http://localhost:3010](http://localhost:3010) after the server is healthy and select Software Engineer in this blueprint's channel. The implementation service must be healthy before the OpenBot server starts. The bot's `/health` endpoint checks service readiness, not provider credential validity.

Use `docker compose logs`, `ps`, `restart` and `down` normally. The packaged `compose.custom-bot.yml` is a reference/compatibility override that mirrors the service already defined in the root stack. When changing the selected blueprint or credentials in an existing stack, recreate services so tenant preparation and environment updates take effect.

## Registration and model configuration

The implementer agent retains its responsibilities and references, with this runtime:

```json
{
  "kind": "remote",
  "protocol": "ag-ui",
  "endpointEnv": "MANAGED_AGENT_AG_UI_URL"
}
```

The exporter emits a remote coworker whose endpoint is resolved from that native variable. The server's managed endpoint must match the registered endpoint exactly to attach `x-openbot-agent-token`. The root Compose file injects the same `MANAGED_AGENT_TOKEN` into the bot. An endpoint that is merely similar, or an unconfigured token, causes authentication to fail.

The separate `.env.implementer` uses native framework-bot names:

```dotenv
BOT_PROVIDER=openai
BOT_MODEL=<implementer-model-id>
OPENAI_API_KEY=<your-existing-provider-key>
OPENAI_BASE_URL=
```

For Anthropic, choose `BOT_PROVIDER=anthropic` and fill `ANTHROPIC_API_KEY` and an available model ID instead. These values configure only this bot service. Root `.env` model settings continue to configure the built-in coworkers. Optional native `BOT_RESPONSES_API` and `BOT_REASONING_EFFORT` settings are included in the template; configure only combinations supported by your provider/model and framework.

The bot receives only its own environment file, the shared managed/tool tokens and a tool callback URL. It does not receive the platform's database, vault or Intelligence credentials. `OPENBOT_TOOL_URL` points to `http://server:3001/api/agent-tools/call` inside the agent network; OpenBot still enforces tool grants and signed run context.

OpenBot forwards role context to remote coworkers. The framework example translates AG-UI messages into model messages; it does not load `prompts/implementer.md` as a local system-prompt file. Customize the service if you need the complete packaged prompt, additional tools, generation parameters or execution limits. Blueprint declarations alone do not implement those behaviors.

## Local URL versus the Docker host

| Caller | Bot URL | How it is reached |
| --- | --- | --- |
| OpenBot server container, default setup | `http://implementer-bot:4201/ag-ui` | Compose DNS on the shared agent network; no published bot port needed |
| Your host, with the host-access override | `http://localhost:4201/ag-ui` | Published port on the Docker engine host |
| OpenBot container calling a host-published bot | `http://host.docker.internal:4201/ag-ui` | Docker Desktop host route or Linux `host-gateway` mapping |
| Another machine using a remote Docker engine/VM | `http://<docker-engine-address>:4201/ag-ui` | Reachable engine address and an explicitly published port |

`localhost` inside `server` points to the server container itself. Do not register `http://localhost:4201/ag-ui` there when the bot runs in another container or on the host.

### Optional host-published access

Keep the internal service URL for normal registration and add the host-access override when you need local debugging:

```sh
docker compose -f docker-compose.yml \
  -f blueprints/software-development-custom-bot/deployment/compose.host-access.yml \
  up --build -d

curl http://localhost:4201/health
```

The default published address is loopback. `/health` is public and reports provider/model metadata; `/ag-ui` requires `x-openbot-agent-token`. For a bot running separately on your Docker host, register its host-routed endpoint in root `.env`:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://host.docker.internal:4201/ag-ui
AGENT_ENDPOINT_ALLOWED_HOSTS=host.docker.internal:4201
```

The root server already has `host.docker.internal:host-gateway` mapping. On Linux, the bot must listen/publish on an interface reachable from that gateway; a host service bound only to `127.0.0.1` generally cannot be reached through the gateway. If using this example's host-access override for that test, set `IMPLEMENTER_BIND_ADDRESS=0.0.0.0` deliberately and restrict access appropriately. For a bot running outside this Compose project, the root server already reads `MANAGED_AGENT_AG_UI_URL` and `MANAGED_AGENT_TOKEN`; changing those values redirects registration. The root stack still provisions its bundled implementer service. If adapting another Compose stack, equivalent server registration looks like this:

```yaml
services:
  server:
    environment:
      MANAGED_AGENT_AG_UI_URL: ${MANAGED_AGENT_AG_UI_URL:?Set the bot endpoint}
      MANAGED_AGENT_TOKEN: ${MANAGED_AGENT_TOKEN:?Set the shared service token}
```

The standalone bot must be configured with the same managed token. Its `OPENBOT_TOOL_URL` must also reach OpenBot from wherever the bot runs; `http://server:3001/...` is valid only on the Compose agent network. A bot on the local host can use `http://localhost:3010/api/agent-tools/call` with the default application port.

For a remote Docker context or legacy Docker Machine VM, `localhost` on your laptop is not the engine host. Use that engine's reachable IP or DNS name and publish the bot on a reachable interface. `host.docker.internal`/`host-gateway` refers to the engine's host or gateway, not automatically your laptop. Change `AGENT_ENDPOINT_ALLOWED_HOSTS` to the actual registered host and port. Docker socket paths are also interpreted on the engine host; choose native `ENGINE_SOCKET` accordingly.

## Package and extend

The deployment templates and this guide are listed in `deployment.files`. Both scaffolding and tenant export preserve them. Scaffolding also copies prompts, so the result remains an editable blueprint; exported tenant metadata retains source-relative prompt paths as described in the main integration guide.

Run the root Compose file, set `BLUEPRINT_DIR` to the scaffolded project's directory, and copy the blank environment templates into your user-managed environment files. The copied custom override is available as a reference, not a prerequisite for default startup. No actual `.env` or `.env.implementer` credentials are packaged.

This service example does not implement automatic workflow scheduling, evidence evaluation or conditional specialist activation. Tool grants and computer policies still need configuration in OpenBot.
