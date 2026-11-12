import { ProductError } from "./access.js";
export async function workspaceCall(operation: "ensure" | "check" | "source" | "import" | "run" | "reconcile", input: Record<string, unknown>) {
  const endpoint = process.env.WORKSPACE_PROVIDER_URL;
  const token = process.env.WORKSPACE_PROVIDER_TOKEN;
  if (!endpoint || !token) throw new ProductError(409, "workspace_unconfigured", "Configure the project workspace provider before initialization.");
  const installationId = process.env.WORKSPACE_PROVIDER_INSTALLATION_ID;
  const payload = installationId ? { ...input, installationId } : input;
  const response = await fetch(new URL("/" + operation, endpoint), {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string } | null;
    if (body?.code === "workspace_path_too_long") throw new ProductError(409, body.code, "The VM provider path is too long. Set LIMA_HOME to a shorter host directory and restart the workspace provider.");
    throw new ProductError(409, "workspace_unavailable", "The project workspace operation needs attention.");
  }
  return await response.json() as { id?: string; ready?: boolean; isolated?: boolean; status?: string; revision?: string | null; hasProject?: boolean; files?: number; excludesUncommittedChanges?: boolean; excludedPaths?: string[]; exitCode?: number; stdout?: string; stderr?: string };
}
