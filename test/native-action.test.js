import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-native-action-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--strict', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/native-action.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireNativeWorkspaceAction } = await import(pathToFileURL(join(directory, 'native-action.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('workspace actions require a server-bound active native run and assignment', async () => {
  const actor = { id: 'owner', role: 'user' }, run = { actorId: 'owner', botId: 'bot', threadId: 'thread', runId: 'native-run' };
  const project = { id: 'project', permissions: ['read', 'work'], state: 'Operational' };
  let active = true;
  const tx = { async unsafe(sql, params) {
    if (sql.includes('select assignment_id')) return [{ assignmentId: 'assignment' }];
    if (sql.includes('from intelligence_channel_mappings')) return [{ channelId: 'channel' }];
    if (sql.includes('from group_bot_threads')) return [];
    if (sql.includes('from bp_conversations')) { assert.equal(params[3], 'assignment'); return [{ projectId: 'project', assignmentId: 'assignment' }]; }
    if (sql.includes('from bp_projects')) return [project];
    if (sql.includes('from bp_native_action_runs')) return active ? [{ actionId: 'implement', assignmentId: 'assignment', operationKey: 'op', tool: 'workspace-edit' }] : [];
    throw Error('Unexpected query');
  } };
  assert.equal((await requireNativeWorkspaceAction(tx, actor, run)).operationKey, 'op');
  active = false;
  await assert.rejects(requireNativeWorkspaceAction(tx, actor, run), error => error.code === 'action_not_found');
  await assert.rejects(requireNativeWorkspaceAction(tx, actor, { ...run, runId: undefined }), error => error.code === 'action_not_found');
});
