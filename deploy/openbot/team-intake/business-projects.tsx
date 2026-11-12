import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { tryClient } from "@/lib/client";
import { ProjectFolderPicker } from "./project-folder-picker";

type Project = { id: string; name: string; state: string; blueprintVersion: string; permissions?: string[] };
type Report = { assignmentId: string; roleKey: string; status: string; checkedAt?: string | null; evidence?: { reason?: string; checks?: { id: string; passed: boolean; evidence: string }[] } };
type Readiness = { teamLeadChannelId?: string | null; project: Project; workspace: { state: string; reason?: string | null; excludedPaths?: string[]; excludesUncommittedChanges?: boolean } | null; reports: Report[]; missingArtifacts: string[]; artifacts?: { typeKey: string; source: { path?: string; reference?: string }; status: string }[] };
type Blueprint = {
  id: string;
  version: string;
  agents: { id: string; name: string }[];
  business: {
    roles: { id: string; agentId: string; responsibility: string }[];
    artifactTypes: { id: string; description: string; schema: { properties?: Record<string, { type?: string }> } }[];
    initialization: { requiredArtifacts: string[]; recommendedArtifacts: string[] };
  };
};

async function responseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error || fallback;
}

export function BusinessProjects({ onShowLegacy }: { onShowLegacy?: () => void }) {
  const labels: Record<string, string> = {
    "team-lead": "Team Lead", pm: "Product Manager", engineer: "Software Engineer",
    qa: "QA", release: "Release Engineer",
  };
  const cache = useQueryClient();
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [references, setReferences] = useState<Record<string, string>>({});
  const [structuredValues, setStructuredValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Keep the same key after a failed submission so retry cannot create another project.
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const blueprint = useQuery({
    queryKey: ["business-blueprint-details"],
    queryFn: async ({ signal }): Promise<Blueprint> => {
      const response = await tryClient("/api/products/blueprint", { signal });
      if (!response.ok) throw new Error(await responseError(response, "Could not load the blueprint."));
      return await response.json() as Blueprint;
    },
  });
  const projects = useQuery({
    queryKey: ["business-projects"],
    queryFn: async ({ signal }): Promise<Project[]> => {
      const response = await tryClient("/api/products", { signal });
      if (!response.ok) throw new Error(await responseError(response, "Could not load projects."));
      return (await response.json() as { projects: Project[] }).projects;
    },
  });
  const readiness = useQuery({
    queryKey: ["business-readiness", selected],
    enabled: Boolean(selected),
    queryFn: async ({ signal }): Promise<Readiness> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(selected)}/readiness`, { signal });
      if (!response.ok) throw new Error(await responseError(response, "Could not load project readiness."));
      return await response.json() as Readiness;
    },
  });
  const projectBlueprint = useQuery({
    queryKey: ["business-project-blueprint", selected],
    enabled: Boolean(selected),
    queryFn: async ({ signal }): Promise<Blueprint> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(selected)}/blueprint`, { signal });
      if (!response.ok) throw new Error(await responseError(response, "Could not load the project blueprint."));
      return await response.json() as Blueprint;
    },
  });

  async function refreshData(projectId: string) {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["business-readiness", projectId] }),
      cache.invalidateQueries({ queryKey: ["business-projects"] }),
    ]);
  }
  function openProject(id: string) {
    setSelected(id);
    setFolder("");
    setReferences({});
    setStructuredValues({});
    setError("");
    setNotice("");
    setConfirmArchive(false);
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/products", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": creationKey },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not create the project."));
      const body = await response.json() as { project: Project };
      openProject(body.project.id);
      setName("");
      setCreationKey(crypto.randomUUID());
      await refreshData(body.project.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
    } finally {
      setPending(false);
    }
  }
  async function initialize(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const artifacts: Record<string, Record<string, unknown>> = {};
    if (folder) artifacts["source-code"] = { path: folder };
    for (const [id, value] of Object.entries(references)) {
      if (value.trim()) artifacts[id] = { reference: value.trim() };
    }
    for (const [id, value] of Object.entries(structuredValues)) {
      if (!value.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        artifacts[id] = parsed as Record<string, unknown>;
      } catch {
        setError(`Enter a valid structured object for ${id}.`);
        return;
      }
    }
    if (!Object.keys(artifacts).length && readiness.data?.missingArtifacts.length) {
      setError("Add the required project artifacts to continue.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(selected)}/initialization`, {
        method: "POST", body: { artifacts },
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not initialize the project."));
      const body = await response.json() as { project?: { excludesUncommittedChanges?: boolean; sourceChanged?: boolean } };
      const messages: string[] = [];
      if (body.project?.sourceChanged) messages.push("The source was updated. Any previous workspace was preserved in the project VM.");
      if (body.project?.excludesUncommittedChanges) messages.push("The workspace uses the committed source. Uncommitted changes were excluded.");
      if (messages.length) setNotice(messages.join(" "));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not initialize the project.");
    } finally {
      await refreshData(selected);
      setPending(false);
    }
  }
  async function recheck() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(selected)}/readiness`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "Could not check team readiness."));
      await refreshData(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not check team readiness.");
    } finally {
      setPending(false);
    }
  }
  async function archive() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(selected)}/archive`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "Could not archive the project."));
      setConfirmArchive(false);
      setNotice("Project archived. Its conversations, artifacts and work history remain available.");
      await refreshData(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not archive the project.");
    } finally { setPending(false); }
  }

  return <div className="min-h-0 flex-1 overflow-y-auto">
    <SidebarToggleBar />
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {onShowLegacy && <Button type="button" variant="outline" onClick={onShowLegacy}>View previous projects</Button>}
      {!selected && <form className="space-y-3 rounded-lg border p-4" onSubmit={event => void create(event)}>
        <label className="block text-sm font-medium" htmlFor="business-project-name">Project name</label>
        <input id="business-project-name" className="w-full rounded-md border bg-background px-3 py-2" value={name}
          onChange={event => {
            setName(event.target.value);
            // A changed payload must use a new idempotency key.
            setCreationKey(crypto.randomUUID());
          }} />
        {blueprint.data && <p className="text-sm text-muted-foreground">Blueprint {blueprint.data.id} · version {blueprint.data.version}</p>}
        <Button type="submit" disabled={!name.trim() || pending}>{pending ? "Creating…" : "Create project"}</Button>
      </form>}
      {(projects.isPending || blueprint.isPending) && <p role="status">Loading projects…</p>}
      {projects.isError && <p role="alert">{projects.error.message}</p>}
      {blueprint.isError && <p role="alert">{blueprint.error.message}</p>}
      {!selected && <ul className="divide-y rounded-lg border">{projects.data?.map(project =>
        <li key={project.id}><button type="button" className="w-full px-4 py-3 text-left hover:bg-muted" onClick={() => openProject(project.id)}>
          <span className="font-medium">{project.name}</span> <span className="text-sm text-muted-foreground">{project.state}</span>
        </button></li>)}</ul>}
      {selected && <section className="space-y-4">
        <Button type="button" variant="outline" onClick={() => openProject("")}>All projects</Button>
        {readiness.isPending && <p role="status">Loading readiness…</p>}
        {readiness.isError && <p role="alert">{readiness.error.message}</p>}
        {projectBlueprint.isError && <p role="alert">{projectBlueprint.error.message}</p>}
        {readiness.data && <>
          <h2 className="text-xl font-semibold">{readiness.data.project.name}</h2>
          <p>Blueprint version {readiness.data.project.blueprintVersion} · {readiness.data.project.state}</p>
          {readiness.data.project.state !== "Archived" && readiness.data.project.permissions?.includes("manage") &&
            (confirmArchive ? <div className="space-x-2"><span>Archive this project?</span>
              <Button type="button" variant="outline" disabled={pending} onClick={() => void archive()}>Confirm archive</Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmArchive(false)}>Cancel</Button></div>
              : <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmArchive(true)}>Archive project</Button>)}
          <p className="text-sm text-muted-foreground">The Team Lead is your point of contact. Add the required project artifacts below, then check that each specialist is ready before starting work.</p>
          {readiness.data.teamLeadChannelId && <Link className="block underline" to="/channel/$channelId"
            params={{ channelId: readiness.data.teamLeadChannelId }}>Open Team Lead conversation</Link>}
          {readiness.data.missingArtifacts.length > 0 && <p role="status">
            Required artifacts still needed: {readiness.data.missingArtifacts.map(id => projectBlueprint.data?.business.artifactTypes.find(item => item.id === id)?.description ?? id).join(", ")}
          </p>}
          {!!readiness.data.artifacts?.length && <section className="space-y-2 rounded-lg border p-4" aria-label="Saved project artifacts">
            <h3 className="font-medium">Saved artifacts</h3>
            <ul className="space-y-1 text-sm">{readiness.data.artifacts.map(artifact => <li key={artifact.typeKey} className="break-all">
              <span className="font-medium">{projectBlueprint.data?.business.artifactTypes.find(item => item.id === artifact.typeKey)?.description ?? artifact.typeKey}:</span>{" "}
              {artifact.source.path ?? artifact.source.reference ?? JSON.stringify(artifact.source)}
            </li>)}</ul>
          </section>}
          {readiness.data.project.state !== "Archived" && <form className="space-y-4 rounded-lg border p-4" onSubmit={event => void initialize(event)}>
            <h3 className="font-medium">Project artifacts</h3>
            {projectBlueprint.data?.business.artifactTypes.some(item => item.id === "source-code") && <ProjectFolderPicker value={folder} onChange={setFolder} />}
            {projectBlueprint.data
              && [...new Set([...projectBlueprint.data.business.initialization.requiredArtifacts, ...projectBlueprint.data.business.initialization.recommendedArtifacts])].filter(id => id !== "source-code").map(id => {
              const artifact = projectBlueprint.data?.business.artifactTypes.find(item => item.id === id);
              const required = projectBlueprint.data?.business.initialization.requiredArtifacts.includes(id);
              return <label key={id} className="block space-y-1 text-sm" htmlFor={`artifact-${id}`}>
                <span className="block font-medium">{artifact?.description || id} <span className="font-normal text-muted-foreground">({required ? "required" : "optional"})</span></span>
                {artifact?.schema.properties?.reference?.type === 'string'
                  ? <input id={`artifact-${id}`} className="w-full rounded-md border bg-background px-3 py-2"
                      value={references[id] ?? ""} onChange={event => setReferences(current => ({ ...current, [id]: event.target.value }))} />
                  : <textarea id={`artifact-${id}`} className="min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono"
                      placeholder="{}" value={structuredValues[id] ?? ""} onChange={event => setStructuredValues(current => ({ ...current, [id]: event.target.value }))} />}
              </label>;
            })}
            <Button type="submit" disabled={pending || !projectBlueprint.data}>{pending ? "Preparing…" : "Save artifacts and prepare"}</Button>
          </form>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">Team readiness</h3>
            {readiness.data.project.state !== "Archived" && <Button type="button" variant="outline" disabled={pending} onClick={() => void recheck()}>Check readiness</Button>}
          </div>
          <p className="text-sm">Workspace · {readiness.data.workspace?.state ?? "Pending"}</p>
          {readiness.data.workspace?.reason && <p role="alert" className="text-sm text-destructive">{readiness.data.workspace.reason}</p>}
          {readiness.data.workspace?.excludesUncommittedChanges && <p className="text-sm">The workspace contains the committed source; uncommitted changes were not copied.</p>}
          {!!readiness.data.workspace?.excludedPaths?.length && <details className="text-sm">
            <summary className="cursor-pointer">Files and folders excluded from the workspace ({readiness.data.workspace.excludedPaths.length})</summary>
            <ul className="mt-2 list-inside list-disc break-all">{readiness.data.workspace.excludedPaths.map(path => <li key={path}>{path}</li>)}</ul>
          </details>}
          {readiness.data.reports.length === 0 && <p>Readiness checks have not completed.</p>}
          <ul className="divide-y rounded-lg border">{readiness.data.reports.map(report => {
            const role = projectBlueprint.data?.business.roles.find(item => item.id === report.roleKey);
            return <li className="space-y-1 px-4 py-3" key={report.assignmentId ?? report.roleKey}>
              <p><span className="font-medium">{projectBlueprint.data?.agents.find(agent => agent.id === role?.agentId)?.name ?? labels[report.roleKey] ?? report.roleKey}</span> · {report.status}</p>
              {role && <p className="text-sm text-muted-foreground">{role.responsibility}</p>}
              {report.evidence?.reason && <p className="text-sm">{report.evidence.reason}</p>}
              {report.evidence?.checks?.map(check => <p className="text-sm" key={check.id}>
                {check.id} · {check.passed ? "Passed" : "Blocked"} · {check.evidence}
              </p>)}
            </li>;
          })}</ul>
        </>}
      </section>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </main>
  </div>;
}
