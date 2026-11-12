const token = process.env.WORKFLOW_ENGINE_TOKEN;
const base = 'http://127.0.0.1:4310';
const input = runId => ({ installationId: 'installation', projectId: 'project', runId, planDigest: 'a'.repeat(64), initialPhase: 'start', phaseIds: ['start'] });
async function post(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${value.error}`);
  return value;
}
async function waitFor(run, state) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const { snapshot } = await post('/status', { run });
      if (snapshot.state === state) return snapshot;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Run ${run.runId} did not reach ${state}.`);
}
const waiting = input('wait-run'), uncertain = input('effect-run');
if (process.argv[2] === 'start') {
  await post('/start', { run: waiting });
  await post('/start', { run: uncertain });
  await waitFor(waiting, 'waiting');
  await waitFor(uncertain, 'uncertain');
} else if (process.argv[2] === 'resume') {
  await waitFor(waiting, 'waiting');
  await waitFor(uncertain, 'uncertain');
  await post('/decision', { run: waiting, decisionId: 'decision-1', value: 'yes' });
  await post('/reconcile', { run: uncertain });
  const first = await waitFor(waiting, 'complete');
  const second = await waitFor(uncertain, 'complete');
  if (first.result !== 'answered' || second.result !== 'reconciled') throw new Error('Unexpected workflow outcome.');
} else throw new Error('Choose start or resume.');
console.log(`Temporal ${process.argv[2]} check passed.`);
