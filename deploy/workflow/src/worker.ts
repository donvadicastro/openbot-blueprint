import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { createActivities } from './activities.js';
import { workflowGateway } from './gateway.js';

const endpoint = process.env.OPENBOT_WORKFLOW_ACTIVITY_URL;
const token = process.env.WORKFLOW_ACTIVITY_TOKEN;
const gatewayToken = process.env.WORKFLOW_ENGINE_TOKEN;
if (!endpoint || !token || !gatewayToken) throw new Error('Configure the workflow activity endpoint and both workflow tokens.');
if (token === gatewayToken) throw new Error('Use distinct workflow activity and gateway tokens.');
const activities = createActivities(endpoint, token);
const address = process.env.TEMPORAL_ADDRESS ?? 'temporal:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'openbot-business';
const connection = await NativeConnection.connect({ address });
const clientConnection = await Connection.connect({ address });
const gateway = workflowGateway(new Client({ connection: clientConnection, namespace }).workflow, gatewayToken, taskQueue);
try {
  const worker = await Worker.create({
    connection, namespace, taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)), activities,
  });
  await new Promise<void>((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(Number(process.env.WORKFLOW_ENGINE_PORT ?? 4310), '0.0.0.0', resolve);
  });
  await worker.run();
} finally {
  if (gateway.listening) await new Promise<void>(resolve => gateway.close(() => resolve()));
  await clientConnection.close();
  await connection.close();
}
