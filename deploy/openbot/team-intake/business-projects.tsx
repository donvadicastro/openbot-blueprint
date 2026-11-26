import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { tryClient } from "@/lib/client";
import { ProjectFolderPicker } from "./project-folder-picker";
import { workflowStatusMessage } from "./workflow-status-message";

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

export function BusinessProjects({ onShowLegacy, onAllProjects, initialProjectId }: { onShowLegacy?: () => void; onAllProjects?: () => void; initialProjectId?: string }) {
  const labels: Record<string, string> = {
    "team-lead": "Team Lead", pm: "Product Manager", engineer: "Software Engineer",
    qa: "QA", release: "Release Engineer",
  };
  const cache = useQueryClient();
  const [selected, setSelected] = useState(initialProjectId ?? "");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [references, setReferences] = useState<Record<string, string>>({});
  const [singleValues, setSingleValues] = useState<Record<string, string>>({});
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
    queryFn: async ({ signal }): Promise<{ projects: Project[]; legacyPending?: number }> => {
      const response = await tryClient("/api/products", { signal });
      if (!response.ok) throw new Error(await responseError(response, "Could not load projects."));
      return await response.json() as { projects: Project[]; legacyPending?: number };
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
    setSingleValues({});
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
    for (const [id, value] of Object.entries(singleValues)) {
      if (!value.trim()) continue;
      const properties = projectBlueprint.data?.business.artifactTypes.find(item => item.id === id)?.schema.properties;
      const fields = Object.entries(properties ?? {});
      if (fields.length !== 1 || fields[0][1].type !== 'string') { setError(`The input format for ${id} changed. Reload the project.`); return; }
      artifacts[id] = { [fields[0][0]]: value.trim() };
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
      {!!projects.data?.legacyPending && <p role="status" className="text-sm">Some previous projects could not be migrated automatically. Open previous projects to access their conversations.</p>}
      {blueprint.isError && <p role="alert">{blueprint.error.message}</p>}
      {!selected && <ul className="divide-y rounded-lg border">{projects.data?.projects.map(project =>
        <li key={project.id}><button type="button" className="w-full px-4 py-3 text-left hover:bg-muted" onClick={() => openProject(project.id)}>
          <span className="font-medium">{project.name}</span> <span className="text-sm text-muted-foreground">{project.state}</span>
        </button></li>)}</ul>}
      {selected && <section className="space-y-4">
        <Button type="button" variant="outline" onClick={() => { openProject(""); onAllProjects?.(); }}>All projects</Button>
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
          <ProjectWork key={selected} projectId={selected} canAnswer={readiness.data.project.state === 'Operational' && !!readiness.data.project.permissions?.includes('work')} />
          {readiness.data.missingArtifacts.length > 0 && <p role="status">
            Required artifacts still needed: {readiness.data.missingArtifacts.map(id => projectBlueprint.data?.business.artifactTypes.find(item => item.id === id)?.description ?? id).join(", ")}
          </p>}
          {readiness.data.missingArtifacts.includes("source-code") && readiness.data.project.permissions?.includes("manage") &&
            <p className="text-sm">Which folder contains the project source? Select it below so the team can prepare its isolated workspace.</p>}
          {!!readiness.data.artifacts?.length && <section className="space-y-2 rounded-lg border p-4" aria-label="Saved project artifacts">
            <h3 className="font-medium">Saved artifacts</h3>
            <ul className="space-y-1 text-sm">{readiness.data.artifacts.map(artifact => <li key={artifact.typeKey} className="break-all">
              <span className="font-medium">{projectBlueprint.data?.business.artifactTypes.find(item => item.id === artifact.typeKey)?.description ?? artifact.typeKey}:</span>{" "}
              {artifact.source.path ?? artifact.source.reference ?? JSON.stringify(artifact.source)}
            </li>)}</ul>
          </section>}
          {readiness.data.project.state !== "Archived" && readiness.data.project.permissions?.includes("manage") && <form className="space-y-4 rounded-lg border p-4" onSubmit={event => void initialize(event)}>
            <h3 className="font-medium">Project artifacts</h3>
            {projectBlueprint.data?.business.artifactTypes.some(item => item.id === "source-code") && <div className="space-y-2">
              <p className="text-sm font-medium">Project source folder ({projectBlueprint.data.business.initialization.requiredArtifacts.includes("source-code") ? "required" : "optional"})</p>
              <ProjectFolderPicker value={folder} onChange={setFolder} />
            </div>}
            {projectBlueprint.data
              && [...new Set([...projectBlueprint.data.business.initialization.requiredArtifacts, ...projectBlueprint.data.business.initialization.recommendedArtifacts])].filter(id => id !== "source-code").map(id => {
              const artifact = projectBlueprint.data?.business.artifactTypes.find(item => item.id === id);
              const required = projectBlueprint.data?.business.initialization.requiredArtifacts.includes(id);
              const fields = Object.entries(artifact?.schema.properties ?? {});
              const singleString = fields.length === 1 && fields[0][1].type === 'string' ? fields[0][0] : undefined;
              return <label key={id} className="block space-y-1 text-sm" htmlFor={`artifact-${id}`}>
                <span className="block font-medium">{artifact?.description || id} <span className="font-normal text-muted-foreground">({required ? "required" : "optional"})</span></span>
                {artifact?.schema.properties?.reference?.type === 'string'
                  ? <input id={`artifact-${id}`} className="w-full rounded-md border bg-background px-3 py-2"
                      value={references[id] ?? ""} onChange={event => setReferences(current => ({ ...current, [id]: event.target.value }))} />
                  : singleString ? <textarea id={`artifact-${id}`} className="min-h-20 w-full rounded-md border bg-background px-3 py-2"
                      value={singleValues[id] ?? ""} onChange={event => setSingleValues(current => ({ ...current, [id]: event.target.value }))} />
                  : <textarea id={`artifact-${id}`} className="min-h-24 w-full rounded-md border bg-background px-3 py-2 font-mono"
                      placeholder="{}" value={structuredValues[id] ?? ""} onChange={event => setStructuredValues(current => ({ ...current, [id]: event.target.value }))} />}
              </label>;
            })}
            <Button type="submit" disabled={pending || !projectBlueprint.data}>{pending ? "Preparing…" : "Save artifacts and prepare"}</Button>
          </form>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">Team readiness</h3>
            {readiness.data.project.state !== "Archived" && readiness.data.project.permissions?.includes("manage") && <Button type="button" variant="outline" disabled={pending} onClick={() => void recheck()}>Check readiness</Button>}
          </div>
          {readiness.data.reports.length > 0 && <p role="status" className="text-sm">
            {readiness.data.reports.filter(report => report.status === "Ready").length} of {readiness.data.reports.length} specialists ready
          </p>}
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

type WorkSummary = { id: string; request: string; conversationId: string };
export type WorkDetail = WorkSummary & { runs: { id: string; state: string; currentPhase: string; canRecover?: boolean;
  attempts: { occurrenceId: string; phase: string; attempt: number; retryNumber: number; state: string; reason: string | null; dispatch: string | null; feedbackClarification: boolean; rejections: { code: string }[] }[];
  qaProgress: { scenarioId: string; status: string; phase: string; occurrenceId: string; attempt: number; total: number; stale: boolean; updatedAt: string;
    steps: string[]; expected: string; observed: string | null; reason: string | null; evidenceId: string | null; reportVerdict: string | null }[];
  decisions: { id: string; state: string; question: string; kind: 'choice' | 'clarification'; choices: string[] | null; deliveryState: string | null; canAnswer: boolean; approval: boolean }[] }[] };

function ProjectWork({ projectId, canAnswer }: { projectId: string; canAnswer: boolean }) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const items = useQuery({ queryKey: ['business-work', projectId], refetchInterval: 5000,
    queryFn: async ({ signal }): Promise<WorkSummary[]> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items`, { signal });
      if (!response.ok) throw new Error(await responseError(response, 'Could not load project work.'));
      return ((await response.json()) as { workItems: WorkSummary[] }).workItems;
    } });
  const detail = useQuery({ queryKey: ['business-work-detail', projectId, selected], enabled: Boolean(selected), refetchInterval: 5000,
    queryFn: async ({ signal }): Promise<WorkDetail> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(selected)}`, { signal });
      if (!response.ok) throw new Error(await responseError(response, 'Could not load this work item.'));
      return ((await response.json()) as { workItem: WorkDetail }).workItem;
    } });
  async function answer(runId: string, decisionId: string, value: string) {
    if (pending) return;
    setPending(true); setError('');
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(selected)}/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decisionId)}`,
        { method: 'POST', body: { value } });
      if (!response.ok) throw new Error(await responseError(response, 'Could not save the decision.'));
      await detail.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the decision.'); }
    finally { setPending(false); }
  }
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Project work">
    <h3 className="font-medium">Project work</h3>
    {items.isPending && <p role="status" className="text-sm">Loading work…</p>}
    {items.isError && <p role="alert" className="text-sm">{items.error.message}</p>}
    {items.data?.length === 0 && <p className="text-sm text-muted-foreground">Work requested from the Team Lead will appear here.</p>}
    {!!items.data?.length && <ul className="space-y-1">{items.data.map(item => <li key={item.id}>
      <button type="button" className="text-left text-sm underline" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setError(''); }}>{item.request}</button>
    </li>)}</ul>}
    {detail.isError && <p role="alert" className="text-sm">{detail.error.message}</p>}
    {detail.data && <div className="space-y-3 text-sm">
      <Link className="underline" to="/channel/$channelId" params={{ channelId: detail.data.conversationId }}>Open originating conversation</Link>
      {detail.data.runs.map(run => <div key={run.id} className="space-y-2 rounded border p-3">
        <p>Phase {run.currentPhase} · {run.state}</p>
        {run.canRecover && <ProjectWorkflowRecovery projectId={projectId} workItemId={selected} runId={run.id} />}
        {run.attempts.map(attempt => <p key={`${attempt.occurrenceId}-${attempt.attempt}`}>
          {attempt.phase} · {attempt.retryNumber > 1 ? `retry ${attempt.retryNumber} · ` : ''}attempt {attempt.attempt} · {attempt.state}{attempt.dispatch ? ` · ${attempt.dispatch}` : ''}
          {attempt.reason && <span> · {attempt.reason}</span>}
          {attempt.rejections.map((rejection, index) => <span key={index}> · {rejection.code}</span>)}
          {attempt.feedbackClarification && <span> · Waiting for feedback clarification</span>}
        </p>)}
        {!!run.qaProgress.length && <QaProgressView scenarios={run.qaProgress} />}
        {run.decisions.filter(decision => decision.state === 'Pending').map(decision => <fieldset key={decision.id} className="space-y-2" disabled={!(decision.canAnswer ?? canAnswer) || pending}>
          <legend className="font-medium">{decision.question}</legend>
          {decision.kind === 'choice' ? <div className="flex flex-wrap gap-2">{decision.choices?.map(choice => <Button type="button" variant="outline" key={choice} onClick={() => void answer(run.id, decision.id, choice)}>{choice}</Button>)}</div> : <div className="space-y-2">
            <textarea className="min-h-20 w-full rounded-md border bg-background px-3 py-2" aria-label={`Answer: ${decision.question}`} maxLength={4000}
              value={answers[decision.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [decision.id]: event.target.value }))} />
            <Button type="button" variant="outline" disabled={!answers[decision.id]?.trim()} onClick={() => void answer(run.id, decision.id, answers[decision.id])}>Send answer</Button>
          </div>}
        </fieldset>)}
        {run.decisions.filter(decision => decision.state === 'Answered').map(decision => <p key={decision.id} role="status">
          {decision.deliveryState === 'Sent' ? 'Decision delivered.' : 'Decision saved; waiting for the workflow to resume.'}
        </p>)}
      </div>)}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

export function ProjectWorkflowRecovery({ projectId, workItemId, runId }: { projectId: string; workItemId: string; runId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const path = `/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs/${encodeURIComponent(runId)}`;
  const status = useQuery({ queryKey: ['workflow-status', projectId, workItemId, runId], refetchInterval: 5000, retry: false,
    queryFn: async ({ signal }): Promise<{ state: string; reasonCode?: string }> => {
      const response = await tryClient(`${path}/status`, { signal });
      if (!response.ok) throw new Error('Workflow status unavailable.');
      return response.json();
    } });
  async function recover() {
    setPending(true); setMessage('');
    try {
      const response = await tryClient(`${path}/reconcile`, { method: 'POST' });
      if (!response.ok) throw new Error(await responseError(response, 'Recovery could not be requested.'));
      setMessage('Recovery requested. The workflow will check the previous operation before continuing.');
      await status.refetch();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Recovery could not be requested.'); }
    finally { setPending(false); }
  }
  if (status.data?.state === 'blocked') return <p role="status">The workflow is blocked. Review the work details for available information.</p>;
  if (status.data?.state !== 'uncertain' && !status.isError && !message) return null;
  return <div className="space-y-1">{(status.isError || status.data?.state === 'uncertain') && <><p>{status.isError ? 'Workflow status is unavailable.' : workflowStatusMessage(status.data?.reasonCode)}</p>
    <Button type="button" variant="outline" disabled={pending} onClick={() => void recover()}>Check and recover interrupted work</Button></>}
    {message && <p role="status">{message}</p>}
  </div>;
}

export function QaProgressView({ scenarios }: { scenarios: WorkDetail['runs'][number]['qaProgress'] }) {
  const groups = new Map<string, typeof scenarios>();
  for (const item of scenarios) {
    const key = `${item.occurrenceId}:${item.attempt}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return <div className="space-y-2" aria-label="Test scenario progress">
    {[...groups.entries()].map(([key, items]) => {
      const passed = items.filter(item => item.status === 'passed').length;
      const total = items[0].total;
      const finished = items.length === total && items.every(item => ['passed', 'failed', 'blocked', 'not-run'].includes(item.status));
      const verdict = items[0].reportVerdict === 'passed' ? 'Passed' : items[0].reportVerdict === 'failed' ? 'Failed' :
        items[0].reportVerdict === 'pending' ? 'Blocked' : finished ? 'Awaiting report' : 'In progress';
      return <div key={key}>
        <p className="font-medium">{verdict} · {passed} of {total} scenarios passed ({total ? Math.round(passed * 100 / total) : 0}%){items.some(item => item.stale) ? ' · Out of date' : ''}</p>
        <ul>{items.map(item => <li key={item.scenarioId}><details>
          <summary>{item.scenarioId} · {item.status}</summary>
          <ol className="list-decimal pl-6">{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          <p>Expected: {item.expected}</p>
          {item.observed && <p>Observed: {item.observed}</p>}
          {item.reason && <p>Reason: {item.reason}</p>}
          {item.evidenceId && <p>Evidence: {item.evidenceId}</p>}
        </details></li>)}</ul>
      </div>;
    })}
  </div>;
}
