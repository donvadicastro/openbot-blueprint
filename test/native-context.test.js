import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'openbot-native-context-'));
execFileSync(resolve('node_modules/.bin/tsc'), ['--ignoreConfig', '--strict', '--skipLibCheck', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--rootDir', resolve('deploy/openbot/product'), '--outDir', directory, resolve('deploy/openbot/product/native-context.ts')]);
await writeFile(join(directory, 'package.json'), '{"type":"module"}');
const { requireNativeBotContext } = await import(pathToFileURL(join(directory, 'native-context.js')).href);
test.after(() => rm(directory, { recursive: true, force: true }));

test('native run resolves a project only from its authenticated thread and bot', async () => {
  const actor = { id: 'person', role: 'user' };
  const run = { actorId: 'person', botId: 'bot', threadId: 'thread' };
  const project = { id: 'project', permissions: ['read', 'work'] };
  let direct = [{ channelId: 'channel' }], group = [];
  const database = { async unsafe(sql, args) {
    if (sql.includes('from intelligence_channel_mappings')) { assert.deepEqual(args, ['thread', 'person', 'bot', false]); return direct; }
    if (sql.includes('from group_bot_threads')) return group;
    if (sql.includes('from bp_conversations')) return [{ projectId: 'project', assignmentId: 'assignment' }];
    if (sql.includes('from bp_projects')) return [project];
    throw Error('Unexpected query');
  } };
  assert.deepEqual(await requireNativeBotContext(database, actor, run, 'work'), { project, assignmentId: 'assignment', channelId: 'channel' });
  await assert.rejects(requireNativeBotContext(database, actor, { ...run, actorId: 'other' }), error => error.code === 'project_not_found');
  direct = []; group = [{ channelId: 'channel' }];
  assert.equal((await requireNativeBotContext(database, actor, run)).channelId, 'channel');
  direct = [{ channelId: 'another-channel' }];
  await assert.rejects(requireNativeBotContext(database, actor, run), error => error.code === 'project_not_found');
  direct = []; group = [];
  await assert.rejects(requireNativeBotContext(database, actor, run), error => error.code === 'project_not_found');
});
