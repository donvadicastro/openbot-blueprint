import { SQL } from 'bun';
import { productDatabaseFromNative } from '/app/server/src/product/store.ts';
import { reconcilePhaseActivity, claimPhaseActivity } from '/app/server/src/product/phase-activity.ts';

const client = new SQL({ hostname: 'postgres', port: 5432, username: 'postgres', password: 'probe', database: 'restored' });
const database = productDatabaseFromNative({ $client: client });
const [request] = await database.unsafe<{ installationId: string; projectId: string; runId: string; planDigest: string; phase: string; occurrence: number; operationKey: string }>(`
  select p.installation_id as "installationId",r.project_id as "projectId",r.id as "runId",r.plan_digest as "planDigest",
    o.phase_key as phase,o.occurrence,o.operation_key as "operationKey"
  from bp_release_effects e join bp_workflow_runs r on (r.project_id,r.id)=(e.project_id,e.run_id)
  join bp_projects p on p.id=r.project_id
  join bp_phase_occurrences o on (o.project_id,o.run_id)=(r.project_id,r.id) and o.phase_key=r.current_phase
  where e.state='Uncertain' and r.id='approval-snapshot-uncertain'`);
if (!request) throw Error('Restored uncertain operation was not found');
const recovered = await database.begin(tx => reconcilePhaseActivity(tx, request));
if (recovered.kind !== 'uncertain') throw Error('Restored uncertain activity was not held');
// The restored database cannot itself prove that its VM is running. Simulate
// a matching provider for this activity check; real VM reconciliation remains
// a separate full-stack acceptance scenario.
const [vm] = await database.unsafe<{ id: string; revision: string }>('select provider_id as id,source_revision as revision from bp_project_vms where project_id=$1', [request.projectId]);
const server = Bun.serve({ port: 0, async fetch(req) {
  const body = await req.json() as { installationId?: string; projectId?: string };
  if (body.installationId !== request.installationId || body.projectId !== request.projectId) return new Response(null, { status: 403 });
  if (new URL(req.url).pathname === '/check') return Response.json({ id: vm.id, ready: true, isolated: true });
  if (new URL(req.url).pathname === '/source') return Response.json({ hasProject: true, revision: vm.revision });
  return new Response(null, { status: 404 });
} });
process.env.WORKSPACE_PROVIDER_URL = `http://127.0.0.1:${server.port}`;
process.env.WORKSPACE_PROVIDER_TOKEN = 'fixture-token';
let held = false;
try { held = (await database.begin(tx => claimPhaseActivity(tx, request))).status === 'uncertain'; }
catch (error: unknown) { held = (error as { code?: string })?.code === 'workflow_input_stale'; }
if (!held) throw Error('Restored uncertain activity was claimed again');
server.stop();
await client.close();
console.log('Verified a restored uncertain activity stays held and cannot be claimed again.');
