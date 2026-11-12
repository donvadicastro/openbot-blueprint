import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, copyFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
const execute = promisify(execFile);

/** Capture only ordinary files inside the explicitly approved source root. */
export async function captureSource(approvedRoot: string, source: string) {
  const root = await realpath(approvedRoot);
  const path = await realpath(source);
  const distance = relative(root, path);
  if (distance === ".." || distance.startsWith("../") || isAbsolute(distance)) throw new Error("Source is outside the approved projects folder.");
  if (!(await lstat(path)).isDirectory()) throw new Error("Choose a source folder.");
  const temporary = await mkdtemp(join(tmpdir(), "openbot-source-"));
  const snapshot = join(temporary, "source");
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  const excludedPaths: string[] = [];
  async function copy(directory: string, destination: string) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(directory)).sort()) {
      if ([".git", "node_modules", ".env", ".openbot"].includes(name) || name.startsWith(".env.")) {
        excludedPaths.push(relative(path, join(directory, name)));
        continue;
      }
      const from = join(directory, name);
      const to = join(destination, name);
      const stat = await lstat(from);
      if (stat.isSymbolicLink()) throw new Error("Source snapshot contains a symbolic link. Resolve it within the source before importing.");
      if (stat.isDirectory()) await copy(from, to);
      else if (stat.isFile()) {
        bytes += stat.size;
        count++;
        if (bytes > 512 * 1024 * 1024 || count > 20000) throw new Error("Source snapshot exceeds the pilot size limit.");
        const content = await readFile(from);
        hash.update(relative(path, from)).update("\0").update(String(stat.mode & 0o777)).update("\0").update(String(content.length)).update("\0").update(content);
        await copyFile(from, to);
      } else throw new Error("Source contains an unsupported special file.");
    }
  }
  try {
    const gitDirectory = await lstat(join(path, ".git")).catch(() => undefined);
    if (gitDirectory?.isDirectory()) {
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" };
      const runGit = (args: string[]) => execute("git", ["-C", path, ...args], { env, maxBuffer: 8 * 1024 * 1024 });
      const revision = (await runGit(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      const tree = (await runGit(["ls-tree", "-l", "-r", "-z", revision])).stdout;
      const entries = tree.split("\0").filter(Boolean);
      const totalBytes = entries.reduce((total, entry) => {
        const match = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(entry);
        return total + (match ? Number(match[1]) : 0);
      }, 0);
      if (entries.length > 20000 || totalBytes > 512 * 1024 * 1024) {
        throw new Error("Source snapshot exceeds the pilot size limit.");
      }
      if (entries.some(entry => /^(120000|160000) /.test(entry))) {
        throw new Error("The committed source contains a symbolic link or submodule.");
      }
      const archive = join(temporary, "source.tar");
      await runGit(["archive", "--format=tar", "--output=" + archive, revision]);
      const bundle = join(temporary, "source.bundle");
      await runGit(["bundle", "create", bundle, "HEAD"]);
      if ((await lstat(bundle)).size > 512 * 1024 * 1024) {
        throw new Error("Source Git history exceeds the pilot size limit.");
      }
      await runGit(["bundle", "verify", bundle]);
      const status = (await runGit(["status", "--porcelain", "--untracked-files=normal"])).stdout;
      return { archive, bundle, digest: revision, files: entries.length, bytes: totalBytes,
        excludesUncommittedChanges: Boolean(status.trim()), cleanup: () => rm(temporary, { recursive: true, force: true }) };
    }
    // A worktree's .git file can point outside the selected folder. Treat its
    // visible files as a plain snapshot and never follow that external pointer.
    if (gitDirectory && !gitDirectory.isFile()) throw new Error("The source Git metadata is not a supported file or directory.");
    await copy(path, snapshot);
    const archive = join(temporary, "source.tar");
    await execute("tar", ["-cf", archive, "-C", snapshot, "."]);
    return { archive, digest: hash.digest("hex"), files: count, bytes, excludedPaths, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
