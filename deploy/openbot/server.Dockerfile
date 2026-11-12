# Adapted from server/Dockerfile at the pinned OpenBot revision.
# The openbot-source build context supplies the upstream source tree.

FROM oven/bun:1.4.3 AS deps

WORKDIR /app

COPY --from=openbot-source package.json bun.lock ./
COPY --from=openbot-source patches patches
COPY --from=openbot-source tsconfig.base.json tsconfig.base.json
COPY --from=openbot-source bunfig.toml bunfig.toml
COPY --from=openbot-source app/package.json app/package.json
COPY --from=openbot-source server/package.json server/package.json
COPY --from=openbot-source worker/package.json worker/package.json
COPY --from=openbot-source shared/package.json shared/package.json
COPY --from=openbot-source toolkit/package.json toolkit/package.json
COPY --from=openbot-source extension/package.json extension/package.json
RUN bun install --frozen-lockfile

FROM deps AS app-build

COPY --from=openbot-source app app
COPY --from=openbot-source scripts scripts
COPY --from=openbot-source shared shared
COPY --from=openbot-source toolkit toolkit
COPY --from=openbot-source server server
COPY --from=openbot-source examples examples
COPY deploy/openbot/team-intake/install.ts /tmp/team-intake-install.ts
COPY deploy/openbot/team-intake/setup-form.tsx app/src/components/channels/team-setup-form.tsx
COPY deploy/openbot/team-intake/project-folder-picker.tsx app/src/components/channels/project-folder-picker.tsx
COPY deploy/openbot/team-intake/team-projects.tsx app/src/components/channels/team-projects.tsx
COPY deploy/openbot/team-intake/business-projects.tsx app/src/components/channels/business-projects.tsx
COPY deploy/openbot/team-intake/projects-route.tsx app/src/routes/_authed/_app/projects.tsx
COPY src/setup-form.ts src/readiness.ts app/src/lib/team-setup/
RUN bun /tmp/team-intake-install.ts app
RUN bun run --cwd app build

FROM oven/bun:1.4.3 AS runtime

RUN groupadd --system --gid 1001 openbot \
  && useradd --system --uid 1001 --gid openbot openbot

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=deps /app/bun.lock bun.lock
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/toolkit/node_modules toolkit/node_modules
COPY --from=deps /app/shared/node_modules shared/node_modules
COPY --from=deps /app/worker/node_modules worker/node_modules

COPY --from=openbot-source server server
COPY --from=openbot-source shared shared
COPY --from=openbot-source toolkit toolkit
COPY --from=openbot-source examples examples
COPY --from=openbot-source worker/package.json worker/package.json
COPY --from=openbot-source worker/src worker/src

# The server imports this policy implementation from the computer source.
COPY --from=openbot-source agent-computer/src/egress.ts agent-computer/src/egress.ts
COPY deploy/openbot/team-intake/install.ts /tmp/team-intake-install.ts
COPY deploy/openbot/team-intake/config.ts server/src/channels/team-intake.ts
COPY deploy/openbot/team-intake/setup-store.ts server/src/channels/team-setup-store.ts
COPY deploy/openbot/team-intake/project-folders.ts server/src/channels/project-folders.ts
COPY src/setup-form.ts src/readiness.ts server/src/channels/
COPY deploy/openbot/product server/src/product
COPY src/types.ts src/schema.ts src/business.ts src/blueprint-contract.ts src/readiness.ts server/src/product/contract/
COPY schemas/blueprint.schema.json server/src/product/contract/blueprint.schema.json
RUN bun /tmp/team-intake-install.ts server

COPY --from=app-build /app/app/dist app/dist
ENV APP_DIST_DIR=/app/app/dist

USER openbot:openbot

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

WORKDIR /app/server

RUN bun -e 'await import("./src/computer/policy-network.ts")'
CMD ["bun", "src/production-entry.ts"]
