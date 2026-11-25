import { SQL } from 'bun';
import { productDatabaseFromNative } from '/app/server/src/product/store.ts';
import { createProductModule } from '/app/server/src/product/module.ts';
import { currentGuidance } from '/app/server/src/product/feedback.ts';

// A separate process reads the same database after the writing process exits.
const client = new SQL({ hostname: 'postgres', port: 5432, username: 'postgres', password: 'probe', database: 'postgres' });
const database = productDatabaseFromNative({ $client: client });
const module = await createProductModule(database, '/fixture');
if (!module) throw Error('project module did not restart');
const [entry] = await database.unsafe<{ projectId: string; assignmentId: string; id: string }>(`
  select e.project_id as "projectId",e.assignment_id as "assignmentId",e.id
  from bp_memory_entries e join bp_memory_revisions r on (r.project_id,r.assignment_id,r.entry_id,r.revision)=(e.project_id,e.assignment_id,e.id,e.current_revision)
  where e.current_revision=3 and r.guidance='Include reproduction steps only for intermittent failures.'`);
if (!entry) throw Error('corrected memory was not persisted');
const guidance = await currentGuidance(module, { id: 'owner', role: 'admin' }, entry.projectId, entry.assignmentId);
if (!guidance.some(item => item.id === entry.id && item.revision === 3)) throw Error('restarted module did not reload corrected memory');
await client.close();
console.log('Verified project feedback is reloaded by a new server process.');
