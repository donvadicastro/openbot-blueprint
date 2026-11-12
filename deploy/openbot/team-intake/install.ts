import { readFileSync, writeFileSync } from "node:fs";

// Apply small, checked edits to the OpenBot revision pinned in docker-compose.yml.
function edit(path: string, changes: [string, string][]) {
  let source = readFileSync(path, "utf8");
  for (const [before, after] of changes) {
    const offset = source.indexOf(before);
    if (offset < 0 || source.indexOf(before, offset + 1) >= 0) {
      throw new Error(`Expected exactly one match in ${path}: ${before}`);
    }
    source = source.replace(before, () => after);
  }
  writeFileSync(path, source);
}

if (process.argv[2] === "server") {
  edit("server/src/index.ts", [
    ['import { createHandoffDesk } from "./agents/handoff";',
     'import { createHandoffDesk } from "./agents/handoff";\nimport { handoffReadinessError } from "./channels/readiness";\nimport { readReadiness, readSetupForm, readTeamIntake } from "./channels/team-intake";\nimport { createSetupStore } from "./channels/team-setup-store";'],
    ["const baseChannelStore = createChannelStore(",
     `const intake = readTeamIntake(config.tenantPackageDirectory);
if (intake?.discoveryBy && process.env.BOT_HANDOFF_MAX_DEPTH === undefined) {
  config.handoff.maxDepth = Math.max(config.handoff.maxDepth, 2);
}
const setupForm = readSetupForm(config.tenantPackageDirectory, new Set(tenantPackage.agents.map(({ id }) => id)));
const teamSetup = setupForm ? await createSetupStore(database, setupForm) : undefined;
const baseChannelStore = createChannelStore(`],
    ["  ...baseChannelStore,",
     `  ...baseChannelStore,
  teamSetup,
`],
    ["const handoffDesk = createHandoffDesk({",
     `const readiness = readReadiness(config.tenantPackageDirectory);
const handoffDesk = createHandoffDesk({
  confirmedSetup: async (from) => {
    if (!teamSetup || from.botId !== intake?.agentId) return;
    if (!from.threadId) return null;
    const result = await teamSetup.get(from.actorId, from.threadId);
    return result ? {
      ...result.answers,
      "setup-confirmation": "Confirmed by the user in the setup form.",
    } : null;
  },
  readinessError: (recipient, constraints) => handoffReadinessError(readiness.get(recipient), constraints),`],
  ]);

  edit("server/src/agents/handoff.ts", [
    ["export function createHandoffDesk(options: {",
     "export function createHandoffDesk(options: {\n  readinessError?: (recipient: string, constraints?: string) => string | undefined;\n  confirmedSetup?: (from: RunAssertion) => Promise<Record<string, string> | null | undefined>;"],
    ["      // Paused by this person: say so now rather than queue a hop that will be dropped.",
     `      const setup = await options.confirmedSetup?.(from);
      if (setup === null) {
        return refuse(from, target, "setup_incomplete", "Complete the team setup form before handing off work.");
      }
      if (setup) envelope = { ...envelope, constraints: JSON.stringify(setup) };
      const readinessError = options.readinessError?.(found.id, envelope.constraints);
      if (readinessError) {
        return refuse(from, target, "readiness_missing", \`Nothing was sent to \${found.name}. \${readinessError}\`);
      }
      // Paused by this person: say so now rather than queue a hop that will be dropped.`],
  ]);

  edit("server/src/app.ts", [
    ['import { type ChannelStore, createChannelRoutes } from "./channels/routes";',
     'import { type ChannelStore, createChannelRoutes } from "./channels/routes";\nimport { readTeamIntake } from "./channels/team-intake";'],
    ["createChannelRoutes(channelStore, requireUser, channelEvents, auditStore),",
     `createChannelRoutes(
        channelStore, requireUser, channelEvents, auditStore,
        readTeamIntake(config.tenantPackageDirectory),
      ),`],
  ]);

  edit("server/src/tenant-package.ts", [
    ['import type { Database } from "./db/client";',
     'import type { Database } from "./db/client";\nimport { readTeamIntake } from "./channels/team-intake";'],
    ["  return database.transaction(async (transaction) => {",
     `  const intake = readTeamIntake(tenantPackage.sourcePath);
  if (intake && (
    !tenantPackage.agents.some(({ id }) => id === intake.agentId) ||
    (intake.handoffTo && !tenantPackage.agents.some(({ id }) => id === intake.handoffTo)) ||
    (intake.discoveryBy && !tenantPackage.agents.some(({ id }) => id === intake.discoveryBy))
  )) {
    throw new Error("Team intake and its handoff must refer to coworkers in the tenant package.");
  }
  return database.transaction(async (transaction) => {`],
    ["    for (const channel of tenantPackage.channels) {",
     `    // Reconcile only grants made by this deployment's intake configuration.
    const intakeGrant = \`team-intake:\${tenantPackage.tenantId}\`;
    await transaction.delete(pluginGrants).where(
      and(eq(pluginGrants.kind, "bot"), eq(pluginGrants.grantedBy, intakeGrant)),
    );
    if (intake?.handoffTo) {
      const grants = [{ agentId: intake.agentId, ref: intake.handoffTo }];
      if (intake.discoveryBy) grants.push({ agentId: intake.handoffTo, ref: intake.discoveryBy });
      await transaction.insert(pluginGrants).values(grants.map(grant => ({
        ...grant, kind: "bot" as const, grantedBy: intakeGrant,
      }))).onConflictDoNothing();
    }

    for (const channel of tenantPackage.channels) {`],
  ]);

  edit("server/src/channels/routes.ts", [
    ['import type { ThreadIdentity } from "./thread-identity";',
     'import type { ThreadIdentity } from "./thread-identity";\nimport type { TeamIntake } from "./team-intake";\nimport { projectFromSource, type SetupStore } from "./team-setup-store";\nimport { listProjectFolders, resolveProjectFolder, PROJECTS_ROOT } from "./project-folders";\nimport { validateSetup } from "./setup-form";'],
    ["export type ChannelStore = {",
     "export type ChannelStore = {\n  teamSetup?: SetupStore;"],
    ["  lastMessageAt: Date | null;\n};",
     "  lastMessageAt: Date | null;\n  description?: string;\n};"],
    ["  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;",
     "  create(actor: AgentActor, agentIds: string[], initialize?: (transaction: ChannelTransaction, channel: AgentChannel) => Promise<void>): Promise<AgentChannel>;"],
    ["    create(actor, agentIds) {\n      return database.transaction(\n        async (transaction) => makeChannel(transaction, actor, agentIds),",
     `    create(actor, agentIds, initialize) {
      return database.transaction(
        async (transaction) => {
          const channel = await makeChannel(transaction, actor, agentIds);
          await initialize?.(transaction, channel);
          return channel;
        },`],
    ["  direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;",
     "  direct(actor: AgentActor, agentId: string, intakeId?: string, fresh?: boolean): Promise<AgentChannel>;"],
    ['const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";',
     'const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";\nconst intakeDescription = (id: string) => `Team intake: ${id}`;'],
    ["    async direct(actor, agentId) {",
     "    async direct(actor, agentId, intakeId, fresh) {\n      const intake = intakeId ? intakeDescription(intakeId) : undefined;"],
    [".select({ id: channels.id })\n            .from(channels)",
     ".select({ id: channels.id, description: channels.description })\n            .from(channels)"],
    [`                sql\`(select count(*) from \${channelAgents} where \${channelAgents.channelId} = \${channels.id}) = 1\`,
              ),
            )
            .orderBy(...ROSTER_ORDER)`,
     `                sql\`(select count(*) from \${channelAgents} where \${channelAgents.channelId} = \${channels.id}) = 1\`,
                intake ? inArray(channels.description, fresh ? [intake] : [intake, PRIVATE_AGENT_CHANNEL_DESCRIPTION]) : undefined,
                intake ? sql\`(select count(*) from \${channelMemberships} where \${channelMemberships.channelId} = \${channels.id}) = 1\` : undefined,
              ),
            )
            .orderBy(...(intake
              ? [desc(sql\`\${channels.description} = \${intake}\`), asc(channels.createdAt), asc(channels.id)]
              : ROSTER_ORDER))`],
    [`          return existing
            ? existing.id
            : await makeChannel(transaction, actor, [agentId]);`,
     `          if (!intake) return existing ? existing.id : await makeChannel(transaction, actor, [agentId]);
          const channelId = existing?.id ?? (await makeChannel(transaction, actor, [agentId])).id;
          if (existing?.description !== intake) {
            await transaction.update(channels).set({ description: intake })
              .where(eq(channels.id, channelId));
            await transaction.update(channelMemberships).set({ pinnedAt: new Date() })
              .where(and(eq(channelMemberships.channelId, channelId), eq(channelMemberships.userId, actor.id)));
          }
          return channelId;`],
    ["      return channel ?? store.create(actor, [agentId]);",
     `      if (channel) return channel;
      if (intake) throw new ChannelNotFoundError(found);
      return store.create(actor, [agentId]);`],
    ["    async get(actor, channelId) {\n      const rows = await database\n        .select({\n          id: channels.id,",
     "    async get(actor, channelId) {\n      const rows = await database\n        .select({\n          id: channels.id,\n          description: channels.description,"],
    ["        lastMessageAt: first.lastMessageAt,",
     "        lastMessageAt: first.lastMessageAt,\n        description: first.description,"],
    ["  auditStore?: AuditStore,\n) {\n  const routes",
     `  auditStore?: AuditStore,
  teamIntake?: TeamIntake,
) {
  const intakeId = teamIntake?.form ? \`\${teamIntake.id}:form:\${store.teamSetup?.revision}\` : teamIntake?.id;
  const isTeamIntake = (channel: AgentChannel) => Boolean(
    teamIntake && intakeId && channel.description === intakeDescription(intakeId) &&
    channel.agentIds.length === 1 && channel.agentIds[0] === teamIntake.agentId,
  );
  const routes`],
    ['  routes.post("/", requireUser, async (context) => {',
     `  routes.get("/team-intake", requireUser, (context) => {
    return teamIntake ? context.json({ name: teamIntake.name }) : context.body(null, 204);
  });

  routes.get("/team-projects", requireUser, async (context) => {
    if (!teamIntake || !store.teamSetup) return context.body(null, 204);
    return context.json({ projects: await store.teamSetup.listProjects(context.var.actor.id) });
  });

  routes.post("/team-projects", requireUser, async (context) => {
    const setup = store.teamSetup;
    if (!teamIntake || !setup || !intakeId) return context.body(null, 404);
    if (context.req.header("content-type") !== "application/json") {
      return context.json({ error: "JSON is required." }, 415);
    }
    const body = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "Invalid project request." }, 400);
    }
    try {
      const actor = context.var.actor;
      if (body.source !== undefined) {
        const validated = validateSetup(setup.form, { answers: { project: body.source } });
        const source = await resolveProjectFolder(validated.value?.answers.project);
        if (!source) {
          return context.json({ error: "Choose a folder inside the project workspace." }, 400);
        }
        return context.json({ project: await setup.addProject(actor.id, source) }, 201);
      }
      const project = typeof body.projectId === "string"
        ? (await setup.listProjects(actor.id)).find(candidate => candidate.id === body.projectId)
        : undefined;
      if (body.projectId !== undefined && !project) return context.body(null, 404);
      const agentIds = body.agentIds ?? [teamIntake.agentId];
      if (!Array.isArray(agentIds) || agentIds.length < 1 || agentIds.length > 20 ||
          agentIds.some(id => typeof id !== "string" || !id.trim()) ||
          new Set(agentIds).size !== agentIds.length) {
        return context.json({ error: "Choose between one and twenty distinct bots." }, 400);
      }
      const channel = await store.create(actor, agentIds, async (transaction, created) => {
        await transaction.update(channels).set({ description: intakeDescription(intakeId) })
          .where(eq(channels.id, created.id));
        if (project) {
          const saved = await setup.finish(actor.id, created.threadId, { answers: { project: project.source } }, transaction);
          if (!saved.value) throw new Error(saved.error);
        }
      });
      return context.json({ channelId: channel.id, source: project?.source }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/team-intake", requireUser, async (context) => {
    if (!teamIntake) return context.body(null, 204);
    if (context.req.header("content-type") !== "application/json") {
      return context.json({ error: "JSON is required." }, 415);
    }
    try {
      const channel = await store.direct(context.var.actor, teamIntake.agentId, intakeId, teamIntake.form);
      return context.json({ channelId: channel.id });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/team-projects/folders", requireUser, async (context) => {
    if (!store.teamSetup) return context.body(null, 404);
    try {
      const result = await listProjectFolders(context.req.query("path") ?? PROJECTS_ROOT);
      return result ? context.json(result) : context.json({ error: "Folder not found." }, 404);
    } catch {
      return context.json({ error: "Couldn’t read that folder." }, 422);
    }
  });

  routes.post("/:channelId/team-setup", requireUser, async (context) => {
    if (context.req.header("content-type") !== "application/json") {
      return context.json({ error: "JSON is required." }, 415);
    }
    try {
      const actor = context.var.actor;
      const channel = await store.get(actor, context.req.param("channelId"));
      if (!store.teamSetup || !channel || !isTeamIntake(channel)) {
        return context.json({ error: "Setup conversation not found." }, 404);
      }
      const input = await context.req.json().catch(() => null);
      if (store.teamSetup.form.questions.some(question => question.id === "project")) {
        const folder = await resolveProjectFolder(input?.answers?.project);
        if (!folder) return context.json({ error: "Choose a folder inside the project workspace." }, 400);
        input.answers.project = folder;
      }
      const result = await store.teamSetup.finish(actor.id, channel.threadId, input);
      if (!result.value) return context.json({ error: result.error }, 400);
      return context.json(result.value);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/", requireUser, async (context) => {`],
    ["      const work = await store.workIn(context.var.actor, [channel]);",
     "      const setup = await store.teamSetup?.get(context.var.actor.id, channel.threadId);\n      const work = await store.workIn(context.var.actor, [channel]);"],
    ["          ...channelDto(channel),\n          work:",
     `          ...channelDto(channel),
          ...(setup?.answers.project ? { project: { ...projectFromSource(setup.answers.project), source: setup.answers.project } } : {}),
          ...(teamIntake && isTeamIntake(channel)
            ? {
                welcomeMessage: teamIntake.welcomeMessage,
                ...(store.teamSetup ? { teamSetup: {
                  form: store.teamSetup.form,
                  complete: Boolean(setup),
                } } : {}),
              }
            : {}),
          work:`],
  ]);
} else if (process.argv[2] === "app") {
  const routes = "app/src/routes/_authed/_app";
  edit("app/src/components/app-sidebar/app-sidebar.tsx", [
    ['import { IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";',
     'import { IconFolder, IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";'],
    ['        <SidebarMenu className="gap-px">', `        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link {...props} to="/projects" activeProps={{ className: "bg-foreground/5" }} />
              )}
            >
              <div className="size-[28px] flex items-center justify-center"><IconFolder /></div>
              <span className="text-sm">Projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>`],
  ]);
  edit(`${routes}/bots.index.tsx`, [
    ['import { IconPlus } from "@tabler/icons-react";',
     'import { IconPlus } from "@tabler/icons-react";\nimport { useQuery } from "@tanstack/react-query";\nimport { tryClient } from "@/lib/client";'],
    ['  const navigate = Route.useNavigate();',
     `  const navigate = Route.useNavigate();
  const { data: intake } = useQuery({
    queryKey: ["team-intake"],
    queryFn: async ({ signal }) => {
      const response = await tryClient("/api/channels/team-intake", { signal });
      return response.ok && response.status !== 204
        ? await response.json() as { name: string }
        : null;
    },
  });`],
    ["      <BotRoster />",
     `      {intake && (
        <Link className="mt-4 inline-block text-sm font-medium underline underline-offset-4" preload={false} to="/projects">
          Open Projects
        </Link>
      )}
      <BotRoster />`],
  ]);
  edit("app/src/lib/channels/queries.ts", [
    ["  lastMessageAt: string | null;",
     "  lastMessageAt: string | null;\n  welcomeMessage?: string;\n  project?: { id: string; name: string; source: string };\n  teamSetup?: { form: import(\"@/lib/team-setup/setup-form\").SetupForm; complete: boolean };"],
  ]);
  edit(`${routes}/channel/$channelId.tsx`, [
    ['import { ChannelChat } from "@/components/channels/channel-chat";',
     'import { ChannelChat } from "@/components/channels/channel-chat";\nimport { TeamSetupGate } from "@/components/channels/team-setup-form";'],
    ["            <SidebarToggle />",
     `            <SidebarToggle />
            {channel.data?.project && (
              <a className="text-sm underline underline-offset-4" href={\`/projects?project=\${encodeURIComponent(channel.data.project.id)}\`}>
                {channel.data.project.name}
              </a>
            )}`],
    [`    <ChannelChat
      channel={channel}
      key={channel.id}
      runtimeAgentId={runtimeAgentId}
    />`,
     `    <TeamSetupGate key={channel.id} channel={channel}>
      <ChannelChat channel={channel} runtimeAgentId={runtimeAgentId} />
    </TeamSetupGate>`],
  ]);
  edit(`${routes}/group/$channelId.tsx`, [
    ["        <SidebarToggle />",
     `        <SidebarToggle />
        {channel.data?.project && (
          <a className="text-sm underline underline-offset-4" href={\`/projects?project=\${encodeURIComponent(channel.data.project.id)}\`}>
            {channel.data.project.name}
          </a>
        )}`],
    ["<GroupChat channelId={channelId} key={channelId} />",
     "<GroupChat channelId={channelId} key={channelId} projectSource={channel.data?.project?.source} />"],
  ]);
  edit("app/src/components/channels/group-chat.tsx", [
    ['export function GroupChat({ channelId }: { channelId: string }) {',
     'export function GroupChat({ channelId, projectSource }: { channelId: string; projectSource?: string }) {'],
    ['              text: draft.text,',
     `              text: projectSource && messages.length === 0
                ? \`Project source: \${projectSource}\n\n\${draft.text}\`
                : draft.text,`],
  ]);
  edit("app/src/components/channels/channel-chat.tsx", [
    ["              transcriptMessages(agent.messages, seed),",
     `              [
                // The deployment supplies this intro. Keep it out of the model's thread history.
                ...(channel.welcomeMessage ? [{
                  id: \`welcome:\${channel.id}\`,
                  role: "assistant" as const,
                  content: channel.welcomeMessage,
                }] : []),
                ...transcriptMessages(agent.messages, seed),
              ],`],
  ]);
} else {
  throw new Error("Choose the app or server build stage.");
}

// Business projects use the existing authenticated app and database.
if (process.argv[2] === "server") {
  edit("server/src/index.ts", [
    ['const intake = readTeamIntake(config.tenantPackageDirectory);',
     'const products = await createProductModule(productDatabaseFromNative(database), config.tenantPackageDirectory);\nconst intake = readTeamIntake(config.tenantPackageDirectory);'],
    ['  teamSetup,', '  teamSetup,\n  products,'],
    ['import { createSetupStore } from "./channels/team-setup-store";',
     'import { createSetupStore } from "./channels/team-setup-store";\nimport { createProductModule } from "./product/module";\nimport { productDatabaseFromNative } from "./product/store";\nimport { createNativeReadinessProbe } from "./product/native-readiness";\nimport { verifyReadinessWorkspace } from "./product/readiness-workspace";'],
    ['const routineRunner = createRoutineRunner({',
     `if (products) channelStore.productFeedbackTranscript = async (threadId, userId, messageId) => {
  const history = await routineIntelligence.getThreadMessages({ threadId, userId });
  return history.messages.some(message => message.role === "user" && "id" in message && message.id === messageId);
};
if (products) channelStore.productReadiness = createNativeReadinessProbe(async ({ checkWorkspace, ...turn }) => createTurnRunner({
  admission: serverTurnAdmission,
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  buildAgentFor,
  toolsForTurn: async () => [{
    definition: { name: "project_workspace_check", description: "Verify that this assigned bot can read the exact project source in its workspace.", parameters: z.toJSONSchema(z.strictObject({})) },
    execute: async (args: unknown) => { z.strictObject({}).parse(args); return checkWorkspace(); },
  }],
})(turn), () => threadIdentity.mint(), input => verifyReadinessWorkspace(products, input));
const routineRunner = createRoutineRunner({`],
  ]);
  edit("server/src/channels/routes.ts", [
    ['  teamSetup?: SetupStore;', '  teamSetup?: SetupStore;\n  products?: import("../product/module").ProductModule;\n  productReadiness?: import("../product/readiness").ReadinessProbe;\n  productFeedbackTranscript?: import("../product/feedback").FeedbackTranscript;'],
  ]);
  edit("server/src/app.ts", [
    ['import { readTeamIntake } from "./channels/team-intake";',
     'import { readTeamIntake } from "./channels/team-intake";\nimport { createProductRoutes } from "./product/routes";'],
    ['  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));',
     '  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));\n  if (channelStore?.products) app.route("/api/products", createProductRoutes(channelStore.products, requireUser, channelStore));'],
  ]);
}
