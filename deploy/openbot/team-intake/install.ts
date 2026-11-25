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
     'import type { ThreadIdentity } from "./thread-identity";\nimport type { TeamIntake } from "./team-intake";\nimport { projectFromSource, type SetupStore } from "./team-setup-store";\nimport { listProjectFolders, resolveProjectFolder, PROJECTS_ROOT } from "./project-folders";\nimport { validateSetup } from "./setup-form";\nimport { businessChannelContext } from "../product/channel-context";'],
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
    if (store.products) return context.json({ error: "Create and manage projects in Business projects." }, 409);
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
    if (store.products) return context.json({ error: "Complete project setup in Business projects." }, 409);
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
     "      const businessProject = store.products ? await businessChannelContext(store.products, context.var.actor, channel.id) : null;\n      const setup = businessProject ? undefined : await store.teamSetup?.get(context.var.actor.id, channel.threadId);\n      const work = await store.workIn(context.var.actor, [channel]);"],
    ["          ...channelDto(channel),\n          work:",
     `          ...channelDto(channel),
          ...(setup?.answers.project ? { project: { ...projectFromSource(setup.answers.project), source: setup.answers.project } } : {}),
          ...(businessProject ? { businessProject, ...(businessProject.isTeamLead ? { welcomeMessage: "I’m your Team Lead. I’ll help you prepare this project and coordinate the specialists. Open this project to provide its required artifacts and check the team’s readiness. You can ask me questions here." } : {}) } : {}),
          ...(!businessProject && teamIntake && isTeamIntake(channel)
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
     'import { IconChevronRight, IconFolder, IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";'],
    ['import { currentUserQueryOptions } from "@/lib/auth/queries";',
     'import { currentUserQueryOptions } from "@/lib/auth/queries";\nimport { agentListQueryOptions } from "@/lib/agents/queries";\nimport { tryClient } from "@/lib/client";'],
    ['  SidebarMenuButton,\n  SidebarMenuItem,',
     '  SidebarMenuAction,\n  SidebarMenuButton,\n  SidebarMenuItem,\n  SidebarMenuSub,\n  SidebarMenuSubButton,\n  SidebarMenuSubItem,'],
    ['  const navigation = navigationFor(currentUser?.role);',
     `  const navigation = navigationFor(currentUser?.role);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [botsExpanded, setBotsExpanded] = useState(true);
  const businessProjects = useQuery({
    queryKey: ["sidebar-business-projects"],
    queryFn: async ({ signal }) => {
      const response = await tryClient("/api/products", { signal });
      if (response.status === 404) return [] as { id: string; name: string; state: string }[];
      if (!response.ok) throw new Error("Could not load projects.");
      return (await response.json() as { projects: { id: string; name: string; state: string }[] }).projects;
    },
  });
  const bots = useQuery(agentListQueryOptions());`],
    ['        <SidebarMenu className="gap-px">', `        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link {...props} to="/projects" search={{ project: undefined, businessProject: undefined }} activeProps={{ className: "bg-foreground/5" }} />
              )}
            >
              <div className="size-[28px] flex items-center justify-center"><IconFolder /></div>
              <span className="text-sm">Projects</span>
            </SidebarMenuButton>
            <SidebarMenuAction className="!top-1 !right-1 !size-8 !w-8 !h-8 rounded-md bg-sidebar-accent/50 hover:bg-sidebar-accent focus-visible:ring-2" type="button" aria-label={projectsExpanded ? "Collapse Projects" : "Expand Projects"} aria-expanded={projectsExpanded} onClick={() => setProjectsExpanded(value => !value)}>
              <IconChevronRight className={projectsExpanded ? "rotate-90 transition-transform" : "transition-transform"} />
            </SidebarMenuAction>
            {projectsExpanded && <SidebarMenuSub>
              {(businessProjects.data ?? []).map(project => <SidebarMenuSubItem key={project.id}>
                <SidebarMenuSubButton render={(props) => <Link {...props} to="/projects" search={{ project: undefined, businessProject: project.id }} activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}>
                  <span>{project.name}</span><span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{project.state}</span>
                </Link>} />
              </SidebarMenuSubItem>)}
              {!businessProjects.isPending && !businessProjects.data?.length && <SidebarMenuSubItem><span className="block px-2 py-1 text-xs text-muted-foreground">No projects yet</span></SidebarMenuSubItem>}
            </SidebarMenuSub>}
          </SidebarMenuItem>
`],
    ['            .map((item) => (\n              <SidebarMenuItem key={item.id}>\n                <SidebarMenuButton\n                  className="hover:bg-foreground/5 h-10"\n                  render={(props) => (\n                    <Link\n                      {...props}\n                      to={item.to}\n                      activeProps={{ className: "bg-foreground/5" }}\n                    />\n                  )}\n                >\n                  <div className="size-[28px] flex items-center justify-center">\n                    <item.icon />\n                  </div>\n                  <span className="text-sm">{item.label}</span>\n                  {/* What waits on you across every Bot; Bots lists them first. */}\n                  {item.id === "bots" ? <BotsNavBadge /> : null}\n                </SidebarMenuButton>\n              </SidebarMenuItem>\n            ))}',
     `            .map((item) => item.id === "bots" ? (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton className="hover:bg-foreground/5 h-10" render={(props) => <Link {...props} to="/bots" activeProps={{ className: "bg-foreground/5" }} />}>
                  <div className="size-[28px] flex items-center justify-center"><item.icon /></div>
                  <span className="text-sm">{item.label}</span><BotsNavBadge />
                </SidebarMenuButton>
                <SidebarMenuAction className="!top-1 !right-1 !size-8 !w-8 !h-8 rounded-md bg-sidebar-accent/50 hover:bg-sidebar-accent focus-visible:ring-2" type="button" aria-label={botsExpanded ? "Collapse Bots" : "Expand Bots"} aria-expanded={botsExpanded} onClick={() => setBotsExpanded(value => !value)}>
                  <IconChevronRight className={botsExpanded ? "rotate-90 transition-transform" : "transition-transform"} />
                </SidebarMenuAction>
                {botsExpanded && <SidebarMenuSub>
                  {(bots.data ?? []).filter(bot => !bot.hidden).map(bot => <SidebarMenuSubItem key={bot.id}>
                    <SidebarMenuSubButton render={(props) => <Link {...props} to="/bots/$agentId" params={{ agentId: bot.id }} activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}><span>{bot.name}</span></Link>} />
                  </SidebarMenuSubItem>)}
                </SidebarMenuSub>}
              </SidebarMenuItem>
            ) : (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton className="hover:bg-foreground/5 h-10" render={(props) => <Link {...props} to={item.to} activeProps={{ className: "bg-foreground/5" }} />}>
                  <div className="size-[28px] flex items-center justify-center"><item.icon /></div>
                  <span className="text-sm">{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}`],
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
        <Link className="mt-4 inline-block text-sm font-medium underline underline-offset-4" preload={false} to="/projects" search={{ project: undefined, businessProject: undefined }}>
          Open Projects
        </Link>
      )}
      <BotRoster />`],
  ]);
  edit("app/src/lib/channels/queries.ts", [
    ["  lastMessageAt: string | null;",
     "  lastMessageAt: string | null;\n  welcomeMessage?: string;\n  project?: { id: string; name: string; source: string };\n  businessProject?: { id: string; name: string; isTeamLead: boolean };\n  teamSetup?: { form: import(\"@/lib/team-setup/setup-form\").SetupForm; complete: boolean };"],
  ]);
  edit(`${routes}/channel/$channelId.tsx`, [
    ['import { ChannelChat } from "@/components/channels/channel-chat";',
     'import { ChannelChat } from "@/components/channels/channel-chat";\nimport { TeamSetupGate } from "@/components/channels/team-setup-form";\nimport { ProjectChatWork } from "@/components/channels/project-chat-work";'],
    ["            <SidebarToggle />",
     `            <SidebarToggle />
            {channel.data?.businessProject && (
              <a className="text-sm underline underline-offset-4" href={\`/projects?businessProject=\${encodeURIComponent(channel.data.businessProject.id)}\`}>
                {channel.data.businessProject.name}
              </a>
            )}
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
      {channel.businessProject && <ProjectChatWork key={channel.id} projectId={channel.businessProject.id} conversationId={channel.id} />}
      <ChannelChat channel={channel} runtimeAgentId={runtimeAgentId} />
    </TeamSetupGate>`],
  ]);
  edit(`${routes}/group/$channelId.tsx`, [
    ['import { GroupChat } from "@/components/channels/group-chat";',
     'import { GroupChat } from "@/components/channels/group-chat";\nimport { ProjectChatWork } from "@/components/channels/project-chat-work";'],
    ["        <SidebarToggle />",
     `        <SidebarToggle />
        {channel.data?.businessProject && (
          <a className="text-sm underline underline-offset-4" href={\`/projects?businessProject=\${encodeURIComponent(channel.data.businessProject.id)}\`}>
            {channel.data.businessProject.name}
          </a>
        )}
        {channel.data?.project && (
          <a className="text-sm underline underline-offset-4" href={\`/projects?project=\${encodeURIComponent(channel.data.project.id)}\`}>
            {channel.data.project.name}
          </a>
        )}`],
    ["<GroupChat channelId={channelId} key={channelId} />",
     `{channel.data?.businessProject && <ProjectChatWork key={channelId} projectId={channel.data.businessProject.id} conversationId={channelId} />}
      <GroupChat channelId={channelId} key={channelId} projectSource={channel.data?.project?.source} />`],
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
     'import { createSetupStore } from "./channels/team-setup-store";\nimport { createProductModule } from "./product/module";\nimport { productDatabaseFromNative } from "./product/store";\nimport { createNativeReadinessProbe } from "./product/native-readiness";\nimport { verifyReadinessWorkspace } from "./product/readiness-workspace";\nimport { callNativeProjectTool, nativeProjectTools } from "./product/native-project-tool";\nimport { callNativeWorkspaceTool, nativeWorkspaceTools } from "./product/native-workspace-tool";\nimport { callNativeWorkflowTool } from "./product/native-workflow-tool";\nimport { callNativeFeedbackTool } from "./product/native-feedback-tool";\nimport { createPhaseExecutor } from "./product/phase-executor";\nimport { createDispatchScheduler } from "./product/dispatch-scheduler";\nimport { guardProjectDelegation } from "./product/delegation-guard";'],
    ['    const coordinated = await coordination.call(input);',
     '    if (products && ["project_context", "project_memory", "project_artifacts", "project_artifact_read", "project_workflows", "project_work", "project_prepare_workflow", "project_memory_propose", "project_workspace_run", "project_workspace_reconcile"].includes(input.name)) {\n      const actor = await actorFor(input.actorId);\n      if (!await agentProfileStore.get(actor, input.botId)) return { text: "Refused. This bot is not available.", isError: true };\n      if (input.name === "project_workspace_run" || input.name === "project_workspace_reconcile") return callNativeWorkspaceTool(products, actor, input);\n      if (input.name === "project_prepare_workflow") return callNativeWorkflowTool(products, actor, input);\n      if (input.name === "project_memory_propose") return callNativeFeedbackTool(products, actor, input, channelStore.productFeedbackTranscript);\n      return callNativeProjectTool(products, actor, input);\n    }\n    if (products && input.name === "message_bot") {\n      const blocked = await guardProjectDelegation(products, await actorFor(input.actorId), input.run);\n      if (blocked) return blocked;\n    }\n    const coordinated = await coordination.call(input);'],
    ['  handoffForActor: (actorId, initiator, depth) =>\n    restrictCoordinationForRun(\n      initiator,\n      coordinationForActor(actorId, initiator, depth),\n    ),',
     `  handoffForActor: (actorId, initiator, depth) =>
    restrictCoordinationForRun(initiator, async (botId: string, input: import("@ag-ui/client").RunAgentInput) => {
      const existing = await coordinationForActor(actorId, initiator, depth)(botId, input);
      if (!products) return existing;
      const forwarded = input.forwardedProps?.openbotRun;
      const assertion = readRunAssertion(forwarded, config.keyEncryptionKey);
      if (forwarded !== undefined && (!assertion || assertion.actorId !== actorId || assertion.botId !== botId || (!assertion.handoff && assertion.threadId && assertion.threadId !== input.threadId))) return existing.filter(tool => tool.name !== "message_bot");
      const actor = await actorFor(actorId);
      const run = assertion?.handoff ? assertion : { actorId, botId, runId: input.runId, threadId: input.threadId };
      const guarded = existing.map(tool => tool.name !== "message_bot" ? tool : { ...tool, execute: async (args: unknown) => {
        const blocked = await guardProjectDelegation(products, await actorFor(actorId), run);
        return blocked?.text ?? tool.execute(args);
      } });
      const stillAllowed = async () => {
        const currentActor = await actorFor(actorId);
        return Boolean(await agentProfileStore.get(currentActor, botId));
      };
      const empty = z.strictObject({});
      const [projectTools, workspaceTools] = await Promise.all([
        nativeProjectTools(products, actor, run, empty, z.strictObject({ artifactId: z.string().min(1).max(200), revisionId: z.string().min(1).max(200).optional() }), stillAllowed),
        nativeWorkspaceTools(products, actor, run, empty, z.strictObject({ argv: z.array(z.string().max(8192)).min(1).max(128) }), stillAllowed),
      ]);
      const teamLead = projectTools.some(tool => tool.name === "project_workflows");
      const planningTool = teamLead ? [{ name: "project_prepare_workflow", ref: "project/project_prepare_workflow",
        description: "Save a workflow interpretation for this request or return a clarification question. A saved plan has not started.",
        parameters: z.strictObject({ request: z.string().min(1).max(20000), interpretation: z.strictObject({ workflowId: z.string().optional(), needsClarification: z.string().optional(), temporary: z.unknown().optional() }) }),
        execute: async (args: unknown) => {
          if (!await stillAllowed()) return "Refused. This bot is not available.";
          const result = await callNativeWorkflowTool(products, await actorFor(actorId), { name: "project_prepare_workflow", args: args as Record<string, unknown>, botId, actorId, run });
          return result?.text ?? "Refused.";
        },
      }] : [];
      const messageId = [...input.messages].reverse().find(message => message.role === "user")?.id;
      const feedbackTool = projectTools.length && messageId ? [{ name: "project_memory_propose", ref: "project/project_memory_propose",
        description: "Record guidance from the user's latest feedback for your role. Compare current memory first; flag an unclear conflict and ask the user to clarify it.",
        parameters: z.strictObject({ guidance: z.string().min(1).max(4000), entryId: z.string().optional(), expectedRevision: z.number().int().positive().optional(), conflict: z.boolean().optional(), resolveConflictId: z.string().optional() }),
        execute: async (args: unknown) => {
          if (!await stillAllowed() || !args || typeof args !== "object" || Array.isArray(args)) return "Refused. Project feedback cannot be recorded.";
          const result = await callNativeFeedbackTool(products, await actorFor(actorId), { name: "project_memory_propose", args: { ...(args as Record<string, unknown>), messageId }, botId, actorId, run }, channelStore.productFeedbackTranscript);
          return result?.text ?? "Refused.";
        },
      }] : [];
      return [...guarded, ...projectTools, ...workspaceTools, ...planningTool, ...feedbackTool];
    }),`],
    ['const routineRunner = createRoutineRunner({',
     `if (products) channelStore.productFeedbackTranscript = async (threadId, userId, messageId) => {
  const history = await routineIntelligence.getThreadMessages({ threadId, userId });
  return history.messages.some(message => message.role === "user" && "id" in message && message.id === messageId);
};
if (products) channelStore.productReadiness = createNativeReadinessProbe(async ({ checkWorkspace, workspaceRequired, ...turn }) => createTurnRunner({
  admission: serverTurnAdmission,
  intelligence: routineIntelligence,
  runner: routineAgentRunner,
  buildAgentFor,
  toolsForTurn: async () => workspaceRequired ? [{
    definition: { name: "project_workspace_check", description: "Verify that this assigned bot can read the exact project source in its workspace.", parameters: z.toJSONSchema(z.strictObject({})) },
    execute: async (args: unknown) => { z.strictObject({}).parse(args); return checkWorkspace(); },
  }] : [],
})(turn), () => threadIdentity.mint(), input => verifyReadinessWorkspace(products, input));
const routineRunner = createRoutineRunner({`],
    ['const app = createApp(',
     `const workflowEnabled = Boolean(products && process.env.WORKFLOW_ENGINE_URL && process.env.WORKFLOW_ENGINE_TOKEN && process.env.WORKFLOW_ACTIVITY_TOKEN);
let workflowScheduler: ReturnType<typeof createDispatchScheduler> | undefined;
if (workflowEnabled && products) {
  const activityToken = process.env.WORKFLOW_ACTIVITY_TOKEN!;
  const engineToken = process.env.WORKFLOW_ENGINE_TOKEN!;
  if (activityToken.length < 32 || engineToken.length < 32 || activityToken === engineToken) throw new Error("Configure distinct workflow tokens of at least 32 characters.");
  channelStore.workflowActivities = createPhaseExecutor(products, async input => {
    const { authorizePhaseMcpCall, bindPhaseMcpTools } = await import("./product/phase-mcp");
    // Only exact MCP refs declared by this phase's bot are considered. OpenBot
    // still enforces its grant at invocation; the wrapper rechecks project,
    // role, phase and artifact scope before each call.
    const nativeMcp = input.projectMcp;
    const projectAgentResolver = createActorAgentResolver({
      loadAgents: loadAgentsForActor, model: runtimeModel, resolveModelApiKey: resolveRuntimeModelApiKey,
      stallGuard, agentFetch,
      loadToolsForActor: (actorId, initiator) => async botId => {
        if (actorId !== input.ownerUserId || botId !== input.agentId || !nativeMcp.grants.length) return [];
        const tools = await loadToolsForActor(actorId, initiator)(botId);
        return bindPhaseMcpTools(tools, nativeMcp.grants,
          (grant, args) => authorizePhaseMcpCall(products, nativeMcp.request, botId, grant, args));
      },
      handoffForActor: () => async () => [],
      get acquireLearnedSkills() { return copilotRuntime.learning?.acquire; },
    });
    const outputParameters = z.strictObject({ type: z.string().min(1).max(200), payload: z.record(z.string(), z.unknown()) });
    const workspaceParameters = z.strictObject({ tool: z.enum(["workspace-edit", "test-runner"]), argv: z.array(z.string().max(8192)).min(1).max(128) });
    const reconcileParameters = z.strictObject({ tool: z.enum(["workspace-edit", "test-runner"]) });
    const qaProgressParameters = z.strictObject({ planRevision: z.string().min(1).max(200), scenarioId: z.string().min(1).max(200), status: z.enum(["queued", "running", "passed", "failed", "blocked", "not-run"]), observed: z.string().min(1).max(4000).optional(), reason: z.string().min(1).max(4000).optional(), evidenceId: z.string().min(1).max(200).optional() });
    return createTurnRunner({
      admission: serverTurnAdmission, intelligence: routineIntelligence, runner: routineAgentRunner,
      buildAgentFor: async ({ ownerUserId, agentId, initiator, depth }) =>
        projectAgentResolver.resolveAgentForActor(await actorFor(ownerUserId), agentId, { initiator, depth }),
      toolsForTurn: async () => input.tools.map(tool => {
        const parameters = tool.kind === "workspace" ? workspaceParameters : tool.kind === "reconcile" ? reconcileParameters : tool.kind === "qa-progress" ? qaProgressParameters : outputParameters;
        return { definition: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(parameters) },
          execute: async (args: unknown) => tool.execute(parameters.parse(args)) };
      }),
    })({ ownerUserId: input.ownerUserId, agentId: input.agentId, routineId: "project-workflow",
      threadId: threadIdentity.mint(), instruction: input.instruction });
  });
  workflowScheduler = createDispatchScheduler(products, { onError: error => console.error("Workflow dispatch held", error instanceof Error ? error.name : "unknown") });
}
const app = createApp(`],
    ['if (config.singleUser) {', 'workflowScheduler?.start();\n\nif (config.singleUser) {'],
    ['      channelActivityListener.stop(),', '      workflowScheduler?.stop() ?? Promise.resolve(),\n      channelActivityListener.stop(),'],
  ]);
  edit("server/src/channels/routes.ts", [
    ['  teamSetup?: SetupStore;', '  teamSetup?: SetupStore;\n  products?: import("../product/module").ProductModule;\n  productReadiness?: import("../product/readiness").ReadinessProbe;\n  productFeedbackTranscript?: import("../product/feedback").FeedbackTranscript;\n  workflowActivities?: import("../product/workflow-activity-routes").WorkflowActivityHandler;'],
  ]);
  edit("server/src/app.ts", [
    ['import { readTeamIntake } from "./channels/team-intake";',
     'import { readTeamIntake } from "./channels/team-intake";\nimport { createProductRoutes } from "./product/routes";\nimport { createWorkflowActivityRoutes } from "./product/workflow-activity-routes";'],
    ['  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));',
     '  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));\n  if (channelStore?.products) app.route("/api/products", createProductRoutes(channelStore.products, requireUser, channelStore));\n  if (channelStore?.workflowActivities && process.env.WORKFLOW_ACTIVITY_TOKEN) app.route("/internal/workflow-activities", createWorkflowActivityRoutes(process.env.WORKFLOW_ACTIVITY_TOKEN, channelStore.workflowActivities));'],
  ]);
}
