import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { BusinessWorkspace } from "../../src/types.js";
import { LimaPathError, LimaWorkspaceProvider } from "./lima.js";

export function workspaceServer(options: {
  token: string;
  installationId: string;
  sourceRoot: string;
  provider?: LimaWorkspaceProvider;
}) {
  if (options.token.length < 32) throw new Error("Configure a workspace provider token of at least 32 characters.");
  const provider = options.provider ?? new LimaWorkspaceProvider();
  const pending = new Map<string, Promise<unknown>>();
  const imports = new Map<string, Promise<unknown>>();
  return createServer(async (request, response) => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + options.token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65536) throw new Error("Request is too large.");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.installationId !== options.installationId || typeof input.projectId !== "string"
        || !/^[a-zA-Z0-9-]{1,80}$/.test(input.projectId)) throw new Error("Project binding is invalid.");
      const id = provider.id(options.installationId, input.projectId);
      let result: unknown;
      if (request.url === "/check") result = await provider.check(id);
      else if (request.url === "/source") result = await provider.sourceStatus(id);
      else if (request.url === "/ensure") {
        let operation = pending.get(id);
        if (!operation) {
          operation = provider.ensure(options.installationId, input.projectId, input.profile as BusinessWorkspace);
          pending.set(id, operation);
          operation.finally(() => pending.delete(id)).catch(() => {});
        }
        result = await operation;
      } else if (request.url === "/run" || request.url === "/reconcile") {
        if (typeof input.operationKey !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(input.operationKey)) throw new Error("Invalid operation key.");
        if (request.url === "/run") {
          if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 128 || input.argv.some((value: unknown) => typeof value !== "string" || value.includes("\0") || value.length > 8192) || !input.argv[0]) throw new Error("Invalid action arguments.");
          if (input.qa !== undefined && (!input.qa || typeof input.qa !== 'object' || Array.isArray(input.qa) || Object.keys(input.qa).some(key => key !== 'revision') || typeof input.qa.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(input.qa.revision))) throw new Error('Invalid QA candidate binding.');
          result = input.qa === undefined
            ? await provider.runAction(id, input.operationKey, input.argv)
            : await provider.runAction(id, input.operationKey, input.argv, input.qa);
        } else result = await provider.reconcileAction(id, input.operationKey);
      } else if (request.url === "/import") {
        if (typeof input.source !== "string") throw new Error("Choose a source folder.");
        const selectedPath = input.source === "/projects" ? options.sourceRoot
          : input.source.startsWith("/projects/") ? join(options.sourceRoot, input.source.slice("/projects/".length))
          : input.source;
        const previous = imports.get(id);
        const operation = (previous ? previous.catch(() => undefined) : Promise.resolve())
          .then(() => provider.importSource(id, options.sourceRoot, selectedPath,
            input.replace === true ? { expectedRevision: input.expectedRevision } : undefined));
        imports.set(id, operation);
        operation.finally(() => {
          if (imports.get(id) === operation) imports.delete(id);
        }).catch(() => {});
        result = await operation;
      } else { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof LimaPathError) {
        response.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ code: "workspace_path_too_long" }));
        return;
      }
      response.writeHead(422, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "The workspace operation could not complete. Verify the project binding, source, and VM provider." }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { WORKSPACE_PROVIDER_TOKEN, BLUEPRINT_INSTALLATION_ID, PROJECTS_HOST_DIR } = process.env;
  if (!WORKSPACE_PROVIDER_TOKEN || !BLUEPRINT_INSTALLATION_ID || !PROJECTS_HOST_DIR) {
    throw new Error("Set WORKSPACE_PROVIDER_TOKEN, BLUEPRINT_INSTALLATION_ID, and PROJECTS_HOST_DIR.");
  }
  const provider = new LimaWorkspaceProvider();
  try {
    await provider.command(["--version"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Cannot find limactl. Install Lima on the host or set LIMACTL_PATH to its executable before starting the workspace provider.");
  }
  workspaceServer({
    provider, token: WORKSPACE_PROVIDER_TOKEN, installationId: BLUEPRINT_INSTALLATION_ID, sourceRoot: PROJECTS_HOST_DIR,
  }).listen(Number(process.env.WORKSPACE_PROVIDER_PORT ?? 4511), "127.0.0.1");
}
