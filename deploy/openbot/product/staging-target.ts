/** Private staging target protocol. The caller must enforce release approvals before deploy. */
export type StagingOperation = { operationId: string; projectId: string; candidateDigest: string; target: string };
export type StagingReceipt = StagingOperation & { receiptId: string };
export type StagingLookup = { status: "confirmed"; receipt: StagingReceipt } | { status: "not-found" } | { status: "uncertain" };

function validOperation(value: StagingOperation) {
  return [value.operationId, value.projectId, value.candidateDigest, value.target].every(item =>
    typeof item === "string" && item.trim().length > 0 && item.length <= 300);
}

/** Only an administrator-configured endpoint is accepted; model-provided URLs never enter this API. */
export function createStagingTarget(endpoint: string, token: string) {
  const base = new URL(endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || token.length < 32) {
    throw new Error("Configure a private staging endpoint and token.");
  }
  async function call(path: "deploy" | "lookup", operation: StagingOperation): Promise<StagingLookup> {
    if (!validOperation(operation)) throw new Error("Invalid staging operation binding.");
    try {
      const response = await fetch(new URL(`/internal/staging/${path}`, base), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(operation),
      });
      if (!response.ok) return { status: "uncertain" };
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: "uncertain" };
      const item = payload as Record<string, unknown>;
      // Only a lookup is allowed to establish absence. Deploy failures are always uncertain.
      if (path === "lookup" && item.status === "not-found" && item.operationId === operation.operationId &&
          item.projectId === operation.projectId && item.candidateDigest === operation.candidateDigest && item.target === operation.target) {
        return { status: "not-found" };
      }
      if (item.status !== "confirmed" || !item.receipt || typeof item.receipt !== "object" || Array.isArray(item.receipt)) return { status: "uncertain" };
      const receipt = item.receipt as Record<string, unknown>;
      if (receipt.operationId !== operation.operationId || receipt.projectId !== operation.projectId ||
          receipt.candidateDigest !== operation.candidateDigest || receipt.target !== operation.target ||
          typeof receipt.receiptId !== "string" || !receipt.receiptId || receipt.receiptId.length > 300) return { status: "uncertain" };
      return { status: "confirmed", receipt: { ...operation, receiptId: receipt.receiptId } };
    } catch { return { status: "uncertain" }; }
  }
  return { deploy: (operation: StagingOperation) => call("deploy", operation), lookup: (operation: StagingOperation) => call("lookup", operation) };
}
