import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { BusinessProjects } from "./business-projects";
import { ProjectFolderPicker } from "./project-folder-picker";
import { tryClient } from "@/lib/client";

type Project = {
  id: string;
  name: string;
  source: string;
  conversations: { channelId: string; title: string }[];
};

export function TeamProjects({ projectId, businessProjectId }: { projectId?: string; businessProjectId?: string }) {
  const [showLegacy, setShowLegacy] = useState(false);
  const navigate = useNavigate();
  const business = useQuery({
    queryKey: ["business-blueprint"],
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await tryClient("/api/products/blueprint", { signal });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error("Could not load the blueprint.");
      return true;
    },
  });
  if (business.isPending) return <p className="p-6">Loading projects…</p>;
  if (business.isError) return <p className="p-6" role="alert">Could not load the blueprint.</p>;
  if (business.data && !showLegacy && (!projectId || businessProjectId)) return <BusinessProjects key={businessProjectId ?? "all"} initialProjectId={businessProjectId} onShowLegacy={() => setShowLegacy(true)} onAllProjects={() => {
    void navigate({ to: "/projects", search: { project: undefined, businessProject: undefined } });
  }} />;
  return <LegacyTeamProjects projectId={projectId} readOnly={business.data} onShowBusiness={business.data ? () => {
    setShowLegacy(false);
    void navigate({ to: "/projects", search: { project: undefined, businessProject: undefined } });
  } : undefined} />;
}

function LegacyTeamProjects({ projectId, readOnly, onShowBusiness }: { projectId?: string; readOnly?: boolean; onShowBusiness?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bots = useQuery({ ...agentListQueryOptions(), enabled: Boolean(projectId) && !readOnly });
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selectedLegacy, setSelectedLegacy] = useState<string[]>([]);
  const projects = useQuery({
    queryKey: ["blueprint-team-projects"],
    staleTime: 0,
    queryFn: async ({ signal }): Promise<Project[] | null> => {
      const response = await tryClient("/api/channels/team-projects", { signal });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error("Couldn’t load projects.");
      return (await response.json() as { projects: Project[] }).projects;
    },
  });

  if (projects.data === null) return <p className="p-6">Projects are unavailable for this blueprint.</p>;
  const project = projects.data?.find(candidate => candidate.id === projectId);

  async function start() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await tryClient("/api/channels/team-projects", {
        method: "POST",
        body: project ? { projectId: project.id, agentIds } : { source },
      });
      if (!response.ok) throw new Error("Couldn’t open the Team Lead conversation. Try again.");
      if (!project) {
        const { project: saved } = await response.json() as { project: { id: string } };
        await queryClient.invalidateQueries({ queryKey: ["blueprint-team-projects"] });
        setCreating(false);
        setSource("");
        await navigate({ to: "/projects", search: { project: saved.id, businessProject: undefined } });
        return;
      }
      const { channelId, source: projectSource } = await response.json() as { channelId: string; source?: string };
      if (projectSource && agentIds.length === 1) {
        stashFirstMessage(channelId, `I’d like to start a new conversation for this project.\n\nProject source: ${projectSource}`);
      }
      await navigate({ to: "/channel/$channelId", params: { channelId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t open the Team Lead conversation.");
    } finally {
      setPending(false);
    }
  }

  async function importPrevious() {
    if (!project || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await tryClient(`/api/products/legacy/${encodeURIComponent(project.id)}/import`, {
        method: "POST", body: { channelIds: selectedLegacy },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { code?: string };
        throw new Error(result.code === "legacy_association_unverified"
          ? "A selected conversation is shared or its original project cannot be verified. Leave it unselected and open it from Previous projects."
          : "Couldn’t import this previous project. Try again.");
      }
      const result = await response.json() as { projectId: string };
      await queryClient.invalidateQueries({ queryKey: ["business-projects"] });
      await navigate({ to: "/projects", search: { project: undefined, businessProject: result.projectId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t import this previous project.");
    } finally { setPending(false); }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SidebarToggleBar />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {onShowBusiness && <Button type="button" variant="outline" onClick={onShowBusiness}>Business projects</Button>}
        {projectId && <Link className="text-sm underline underline-offset-4" to="/projects" search={{ project: undefined, businessProject: undefined }}>All projects</Link>}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{project?.name ?? "Projects"}</h1>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {project ? "A space for your project artifacts and conversations." : "Choose a project to work with your bots."}
            </p>
          </div>
          {!readOnly && !projectId && !creating && <Button type="button" disabled={projects.isPending} onClick={() => setCreating(true)}>New project</Button>}
        </div>
        {!readOnly && creating && !projectId && (
          <section className="space-y-3 rounded-lg border p-4" aria-label="New project">
            <ProjectFolderPicker value={source} onChange={setSource} />
            <Button type="button" disabled={!source || pending} onClick={() => void start()}>Create project</Button>
          </section>
        )}
        {project && (
          <>
            <section className="space-y-2 rounded-lg border p-4">
              <h2 className="font-medium">Artifacts</h2>
              <p className="break-all text-sm">{project.source}</p>
            </section>
            {readOnly && <section className="space-y-3 rounded-lg border p-4" aria-label="Import previous project">
              <h2 className="font-medium">Import into business projects</h2>
              <p className="text-sm text-muted-foreground">Choose private conversations to attach. Unselected conversations remain available here; shared or unverifiable conversations cannot be attached.</p>
              {project.conversations.map(({ channelId, title }) => <label key={channelId} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selectedLegacy.includes(channelId)} disabled={pending} onChange={event => {
                  const checked = event.target.checked;
                  setSelectedLegacy(current => checked ? [...current, channelId] : current.filter(id => id !== channelId));
                }} />{title}
              </label>)}
              <Button type="button" disabled={pending} onClick={() => void importPrevious()}>{pending ? "Importing…" : "Import project"}</Button>
            </section>}
            {!readOnly && <fieldset className="space-y-2 rounded-lg border p-4" disabled={pending}>
              <legend className="px-1 font-medium">Choose bots for a new conversation</legend>
              {bots.isPending && <p className="text-sm">Loading bots…</p>}
              {bots.isError && <Button type="button" variant="outline" onClick={() => void bots.refetch()}>Retry loading bots</Button>}
              {bots.data?.filter(bot => !bot.hidden).map(bot => (
                <label className="flex items-center gap-2 text-sm" key={bot.id}>
                  <input type="checkbox" checked={agentIds.includes(bot.id)}
                    disabled={agentIds.length >= 20 && !agentIds.includes(bot.id)}
                    onChange={event => {
                      const selected = event.target.checked;
                      setAgentIds(current => selected ? [...current, bot.id] : current.filter(id => id !== bot.id));
                    }} />
                  {bot.name}
                </label>
              ))}
              <Button type="button" disabled={!agentIds.length || pending} onClick={() => void start()}>
                {pending ? "Opening…" : "New conversation"}
              </Button>
            </fieldset>}
          </>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {projects.isPending && <p role="status" className="text-sm text-muted-foreground">Loading projects…</p>}
        {projects.isError && <Button variant="outline" onClick={() => void projects.refetch()}>Retry loading projects</Button>}
        {projectId && projects.isSuccess && !project && <p className="text-sm">Project not found.</p>}
        {!projectId && projects.data?.length === 0 && <p className="text-sm text-muted-foreground">{readOnly ? "No previous projects were found." : "Choose a folder to start your first project."}</p>}
        {project?.conversations.length ? (
          <ul aria-label="Conversations" className="divide-y rounded-lg border">
            {project.conversations.map(({ channelId, title }) => <li key={channelId}>
              <Link className="block px-4 py-3 hover:bg-muted" to="/channel/$channelId" params={{ channelId }}>{title}</Link>
            </li>)}
          </ul>
        ) : !projectId && Boolean(projects.data?.length) ? (
          <ul aria-label="Projects" className="divide-y rounded-lg border">
            {projects.data?.map(item => <li key={item.id}>
              <Link className="block px-4 py-3 hover:bg-muted" to="/projects" search={{ project: item.id, businessProject: undefined }}>
                <span className="font-medium">{item.name}</span>
                <span className="ml-3 text-sm text-muted-foreground">
                  {item.conversations.length} {item.conversations.length === 1 ? "conversation" : "conversations"}
                </span>
              </Link>
            </li>)}
          </ul>
        ) : null}
      </main>
    </div>
  );
}
