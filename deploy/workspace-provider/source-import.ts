import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const snapshotter = fileURLToPath(new URL("../../../deploy/workspace-provider/source_snapshot.py", import.meta.url));

type SnapshotRecord = {
  archive: string;
  bundle?: string;
  digest: string;
  files: number;
  bytes: number;
  excludedPaths: string[];
  excludesUncommittedChanges: boolean;
};

/** Capture a bounded source tree using descriptor-relative, no-follow traversal. */
export async function captureSource(approvedRoot: string, source: string) {
  const temporary = await mkdtemp(join(tmpdir(), "openbot-source-"));
  try {
    const { stdout } = await execute(process.env.PYTHON ?? "python3", [snapshotter, resolve(approvedRoot), resolve(source), temporary], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180_000,
    });
    const record = JSON.parse(stdout) as SnapshotRecord;
    const inTemporary = (path: string) => typeof path === "string" && resolve(path).startsWith(temporary + sep);
    if (!record || !inTemporary(record.archive) || (record.bundle !== undefined && !inTemporary(record.bundle)) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.digest) || !Number.isSafeInteger(record.files) || record.files < 0 ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Array.isArray(record.excludedPaths) ||
        !record.excludedPaths.every(path => typeof path === "string") || typeof record.excludesUncommittedChanges !== "boolean") {
      throw new Error("The source snapshot helper returned invalid metadata.");
    }
    return { ...record, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (error as NodeJS.ErrnoException).syscall === "spawn python3") {
      throw new Error("Python 3 is required for safe source folder intake.");
    }
    const diagnostic = (error as { stderr?: Buffer | string }).stderr;
    if (diagnostic) throw new Error(diagnostic.toString().trim() || "Source snapshot failed.");
    throw error;
  }
}
