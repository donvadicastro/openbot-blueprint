import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tryClient } from '@/lib/client';
import { QaProgressView, type WorkDetail } from './business-projects';
import { workflowStatusMessage } from './workflow-status-message';

type WorkSummary = { id: string; request: string; conversationId: string };
type RoleView = { id: string; role: string; label: string; recordTypes: string[] };
type QaState = { projectId: string; conversationId: string; workItemId: string; runId: string; viewId: string;
  records: { type: string; revisionId: string; stale: boolean; fields: Record<string, unknown> }[];
  qaProgress: WorkDetail['runs'][number]['qaProgress'] };

/** Show only work originating in this conversation and use the blueprint's QA view. */
export function ProjectChatWork({ projectId, conversationId }: { projectId: string; conversationId: string }) {
  const [selected, setSelected] = useState('');
  const [selectedView, setSelectedView] = useState('');
  const items = useQuery({ queryKey: ['chat-work', projectId, conversationId], refetchInterval: 10000,
    queryFn: async ({ signal }): Promise<WorkSummary[]> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items`, { signal });
      if (!response.ok) throw new Error('Project work is unavailable.');
      return ((await response.json()) as { workItems: WorkSummary[] }).workItems.filter(item => item.conversationId === conversationId);
    } });
  const blueprint = useQuery({ queryKey: ['chat-blueprint', projectId],
    queryFn: async ({ signal }): Promise<RoleView[]> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/blueprint`, { signal });
      if (!response.ok) throw new Error('Project views are unavailable.');
      const data = await response.json() as { agents?: { id: string; name: string }[]; business?: {
        roles?: { id: string; agentId: string }[]; views?: { id: string; role: string; recordTypes: string[] }[] } };
      return (data.business?.views ?? []).map(view => {
        const role = data.business?.roles?.find(item => item.id === view.role);
        return { ...view, label: data.agents?.find(agent => agent.id === role?.agentId)?.name ?? view.role };
      });
    } });
  const visible = !items.isError && items.data?.some(item => item.id === selected);
  const detail = useQuery({ queryKey: ['chat-work-detail', projectId, selected], enabled: Boolean(visible), refetchInterval: 5000,
    queryFn: async ({ signal }): Promise<WorkDetail> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(selected)}`, { signal });
      if (!response.ok) throw new Error('Work details are unavailable.');
      return ((await response.json()) as { workItem: WorkDetail }).workItem;
    } });
  const preferredRole = detail.data?.runs.some(run => run.qaProgress.length > 0) ? 'qa' : 'team-lead';
  const activeView = blueprint.data?.find(view => view.id === selectedView) ?? blueprint.data?.find(view => view.role === preferredRole) ?? blueprint.data?.[0];
  const approvalView = blueprint.data?.find(view => view.recordTypes.includes('release-target') && view.recordTypes.includes('qa-evidence'));
  if (items.isError || !items.data?.length) return null;
  return <details className="border-b px-3 py-2 text-sm">
    <summary className="cursor-pointer font-medium">Project work in this conversation</summary>
    <div className="space-y-2 py-2">
      <ul>{items.data.map(item => <li key={item.id}><button type="button" className="text-left underline" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{item.request}</button></li>)}</ul>
      {visible && !!blueprint.data?.length && <label className="block">Specialist view{' '}
        <select className="rounded border bg-background px-2 py-1" value={activeView?.id ?? ''} onChange={event => setSelectedView(event.target.value)}>
          {blueprint.data.map(view => <option key={view.id} value={view.id}>{view.label}</option>)}
        </select>
      </label>}
      {visible && !detail.isError && detail.data?.conversationId === conversationId && detail.data.runs.map(run => <div key={run.id} className="space-y-2 rounded border p-2">
        <p>Phase {run.currentPhase} · {run.state}</p>
        {run.attempts.at(-1) && <p>Attempt {run.attempts.at(-1)?.retryNumber ?? 1} · {run.attempts.at(-1)?.state}</p>}
        {run.attempts.at(-1)?.reason && <p>{run.attempts.at(-1)?.reason}</p>}
        {run.state === 'Running' && run.attempts.at(-1)?.feedbackClarification && <p role="status">Waiting for feedback clarification. Clarify the conflicting feedback with the specialist to continue.</p>}
        {run.state === 'Running' && run.attempts.at(-1)?.state === 'Running' && !!run.attempts.at(-1)?.rejections?.length && <p role="status">The specialist result was rejected and needs attention.</p>}
        {run.canRecover && <WorkflowStatus projectId={projectId} workItemId={selected} runId={run.id} />}
        {!blueprint.isError && activeView && <LiveDomainView key={activeView.id} projectId={projectId} conversationId={conversationId} workItemId={selected} runId={run.id} viewId={activeView.id} releaseSummary={activeView.id === approvalView?.id} />}
        {!blueprint.isError && approvalView && approvalView.id !== activeView?.id && (run.decisions.some(decision => decision.state === 'Pending' && decision.approval) || (run.state === 'Completed' && run.currentPhase === 'released')) && <div className="space-y-1">
          <p className="font-medium">Release evidence</p>
          <LiveDomainView key={approvalView.id} projectId={projectId} conversationId={conversationId} workItemId={selected} runId={run.id} viewId={approvalView.id} releaseSummary />
        </div>}
        {run.decisions.filter(decision => decision.state === 'Pending').map(decision => <ChatDecision key={decision.id} projectId={projectId} workItemId={selected} runId={run.id} decision={decision} onSaved={() => { void detail.refetch(); }} />)}
      </div>)}
    </div>
  </details>;
}

function WorkflowStatus({ projectId, workItemId, runId }: { projectId: string; workItemId: string; runId: string }) {
  const status = useQuery({ queryKey: ['workflow-status', projectId, workItemId, runId], refetchInterval: 5000, retry: false,
    queryFn: async ({ signal }): Promise<{ state: string; reasonCode?: string }> => {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs/${encodeURIComponent(runId)}/status`, { signal });
      if (!response.ok) throw new Error('Workflow status unavailable');
      return response.json();
    } });
  if (status.data?.state === 'uncertain') return <div><p role="status">{workflowStatusMessage(status.data.reasonCode)}</p><RecoveryButton projectId={projectId} workItemId={workItemId} runId={runId} /></div>;
  if (status.data?.state === 'blocked') return <p role="status">The workflow is blocked. Review the work details for available information.</p>;
  if (status.isError) return <div><p>Workflow status is unavailable.</p><RecoveryButton projectId={projectId} workItemId={workItemId} runId={runId} /></div>;
  return null;
}

function RecoveryButton({ projectId, workItemId, runId }: { projectId: string; workItemId: string; runId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function recover() {
    setPending(true); setMessage('');
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs/${encodeURIComponent(runId)}/reconcile`, { method: 'POST' });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || 'Recovery could not be requested.');
      setMessage('Recovery requested. The workflow will check the previous operation before continuing.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Recovery could not be requested.'); }
    finally { setPending(false); }
  }
  return <div><button className="rounded border px-2 py-1" type="button" disabled={pending} onClick={() => void recover()}>Check and recover interrupted work</button>{message && <p role="status">{message}</p>}</div>;
}

function ChatDecision({ projectId, workItemId, runId, decision, onSaved }: { projectId: string; workItemId: string; runId: string;
  decision: WorkDetail['runs'][number]['decisions'][number]; onSaved: () => void }) {
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(value: string) {
    if (pending || !value.trim()) return;
    setPending(true); setError('');
    try {
      const response = await tryClient(`/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(decision.id)}`,
        { method: 'POST', body: { value } });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || 'The decision could not be saved.');
      }
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The decision could not be saved.'); }
    finally { setPending(false); }
  }
  return <fieldset className="space-y-2" disabled={pending || decision.canAnswer === false}>
    <legend className="font-medium">{decision.question}</legend>
    {decision.kind === 'choice' ? <div className="flex flex-wrap gap-2">{decision.choices?.map(choice =>
      <button className="rounded border px-2 py-1" type="button" key={choice} onClick={() => void submit(choice)}>{choice}</button>)}</div> : <div className="space-y-2">
      <textarea className="min-h-20 w-full rounded border bg-background px-2 py-1" aria-label={`Answer: ${decision.question}`} maxLength={4000} value={answer} onChange={event => setAnswer(event.target.value)} />
      <button className="rounded border px-2 py-1" type="button" disabled={!answer.trim()} onClick={() => void submit(answer)}>Send answer</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

function LiveDomainView({ projectId, conversationId, workItemId, runId, viewId, releaseSummary = false }: { projectId: string; conversationId: string; workItemId: string; runId: string; viewId: string; releaseSummary?: boolean }) {
  const [state, setState] = useState<QaState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    async function connect() {
      while (!controller.signal.aborted) {
        try {
          const path = `/api/products/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs/${encodeURIComponent(runId)}/views/${encodeURIComponent(viewId)}/events`;
          const response = await tryClient(path, { signal: controller.signal });
          if ([401, 403, 404].includes(response.status)) { setState(null); return; }
          if (!response.ok || !response.body) throw new Error('Stream unavailable');
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let snapshotReceived = false;
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.length > 2_000_000) throw new Error('State event too large');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (!data) continue;
              const event = JSON.parse(data) as { type: string; snapshot?: QaState | null; delta?: { op: string; path: string; value: QaState }[] };
              let value: QaState | null | undefined;
              if (event.type === 'STATE_SNAPSHOT') { snapshotReceived = true; value = event.snapshot; }
              else if (event.type === 'STATE_DELTA' && snapshotReceived && event.delta?.length === 1 && event.delta[0].op === 'replace' && event.delta[0].path === '') value = event.delta[0].value;
              else throw new Error('Invalid state sequence');
              if (value === null) { setState(null); await reader.cancel(); break; }
              if (!value || value.projectId !== projectId || value.conversationId !== conversationId || value.workItemId !== workItemId || value.runId !== runId || value.viewId !== viewId || !Array.isArray(value.qaProgress) || !Array.isArray(value.records)) throw new Error('Invalid state binding');
              setState(value);
            }
          }
        } catch { /* Retain the last state during a transient disconnect. */ }
        if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    void connect();
    return () => { controller.abort(); };
  }, [projectId, conversationId, workItemId, runId, viewId]);
  if (!state || (!state.qaProgress.length && !state.records.length)) return null;
  const deployment = releaseSummary ? state.records.find(record => record.type === 'deployment-evidence' && record.fields.verified === true && typeof record.fields.target === 'string' && !record.stale) : undefined;
  return <div className="space-y-2">
    {deployment && <p role="status" className="font-medium">Verified release to {String(deployment.fields.target)}.</p>}
    {!!state.qaProgress.length && <QaProgressView scenarios={state.qaProgress} />}
    {state.records.map(record => <details key={`${record.type}:${record.revisionId}`} className="rounded border p-2">
      <summary>{record.type}{record.stale ? ' · Out of date' : ''}</summary>
      <DomainValue value={record.fields} />
    </details>)}
  </div>;
}

function DomainValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span>—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (depth >= 6) return <span>Further details omitted.</span>;
  if (Array.isArray(value)) return <ul className="list-disc space-y-1 pl-5">{value.slice(0, 50).map((item, index) => <li key={index}><DomainValue value={item} depth={depth + 1} /></li>)}{value.length > 50 && <li>Additional items omitted.</li>}</ul>;
  const entries = Object.entries(value);
  return <dl className="space-y-1 pl-2">{entries.slice(0, 50).map(([field, item]) => <div key={field}><dt className="font-medium">{field}</dt><dd><DomainValue value={item} depth={depth + 1} /></dd></div>)}{entries.length > 50 && <div>Additional fields omitted.</div>}</dl>;
}
