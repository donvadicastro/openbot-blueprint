import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir, open, readFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BusinessWorkspace } from "../../src/types.js";
import { captureSource } from "./source-import.js";
import { registryTransaction } from "../../src/file-lock.js";
import { guestIsolationSetup, guestIsolationVerify, guestProjectAccess } from "./guest-isolation.js";
import { guestQaAction } from "./qa-sandbox.js";
const execute = promisify(execFile);

export class LimaPathError extends Error {
  constructor() { super("The VM provider path is too long. Set LIMA_HOME to a shorter host directory and restart the workspace provider."); }
}

export class LimaWorkspaceProvider {
  constructor(private readonly binary = process.env.LIMACTL_PATH ?? "limactl", private readonly providerHome = resolve(process.env.LIMA_HOME ?? join(homedir(), ".lima"))) {}

  id(installation: string, project: string) {
    return "obot-" + createHash("sha256").update(JSON.stringify([installation, project])).digest("hex").slice(0, 24);
  }
  private lockDirectory(id: string) {
    const providerHome = this.providerHome;
    const homeId = createHash("sha256").update(providerHome).digest("hex").slice(0, 16);
    return join(dirname(providerHome), ".openbot-vm-locks", homeId, id);
  }
  async command(args: string[]) {
    try { return await execute(this.binary, args, { timeout: 240000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) {
      if (typeof (error as { stderr?: unknown }).stderr === "string" && (error as { stderr: string }).stderr.includes("UNIX_PATH_MAX")) throw new LimaPathError();
      throw error;
    }
  }
  private async verifyIsolation(id: string) {
    try {
      await this.command(["shell", id, "--", "sudo", "-n", "sh", "-eu", "-c", guestIsolationVerify]);
      return true;
    } catch { return false; }
  }
  private async configureIsolation(id: string) {
    await this.command(["shell", id, "--", "sudo", "-n", "sh", "-eu", "-c", guestIsolationSetup + guestIsolationVerify]);
  }
  private async prepareProject(id: string) {
    await this.command(["shell", id, "--", "sh", "-eu", "-c", guestProjectAccess]);
  }
  async check(id: string) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid workspace identifier.");
    const result = await this.command(["list", "--json"]);
    const rows = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const row = rows.find(row => row.name === id);
    if (!row) return { id, ready: false, status: "Missing" };
    if (row.status !== "Running") return { id, ready: false, status: row.status };
    try {
      await this.command(["shell", id, "--", "true"]);
      const isolated = await this.verifyIsolation(id);
      return { id, ready: isolated, status: isolated ? row.status : "IsolationUnverified", isolated,
        ...(isolated ? { qaSandbox: 'git-readonly-v1' } : {}) };
    } catch {
      return { id, ready: false, status: "Unreachable" };
    }
  }
  async sourceStatus(id: string) {
    if (!/^obot-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid project VM.");
    return registryTransaction(this.lockDirectory(id), async () => {
      const result = await this.command(["shell", id, "--", "sh", "-c", 'if [ -f "$HOME/.openbot/source-revision" ]; then cat "$HOME/.openbot/source-revision"; fi; printf "\\n"; if [ -d "$HOME/project" ]; then printf "present\\n"; else printf "missing\\n"; fi']);
      const lines = result.stdout.split("\n");
      const [revision, state] = lines;
      if (lines.length !== 3 || lines[2] !== "" || !["present", "missing"].includes(state) || (revision && !/^[a-f0-9]{40,64}$/.test(revision))) throw new Error("The guest source state is invalid.");
      return { revision: revision || null, hasProject: state === "present" };
    }, 300000);
  }
  /** Install only a public, self-signed CA in one guest. Egress remains disabled. */
  async installDependencyAuthority(id: string, certificate: Buffer) {
    if (!/^obot-[a-f0-9]{24}$/.test(id) || !Buffer.isBuffer(certificate) || certificate.length > 8192) throw new Error('Invalid dependency authority.');
    const pem = certificate.toString('utf8');
    if (!/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----\r?\n?$/.test(pem)) throw new Error('Invalid dependency authority.');
    let authority: X509Certificate;
    try { authority = new X509Certificate(certificate); } catch { throw new Error('Invalid dependency authority.'); }
    const from = Date.parse(authority.validFrom), until = Date.parse(authority.validTo);
    if (!authority.ca || !authority.checkIssued(authority) || !authority.verify(authority.publicKey) ||
        !Number.isFinite(from) || !Number.isFinite(until) || from > Date.now() || until <= Date.now()) throw new Error('Invalid dependency authority.');
    const digest = createHash('sha256').update(authority.raw).digest('hex');
    return registryTransaction(this.lockDirectory(id), async () => {
      if (!(await this.check(id)).ready) throw new Error('The project VM is unavailable.');
      const script = `set -eu
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s' "$1" | base64 -d > "$tmp"
test "$(openssl x509 -in "$tmp" -outform DER | sha256sum | cut -d' ' -f1)" = "$2"
install -o root -g root -m 0644 "$tmp" /usr/local/share/ca-certificates/openbot-project-egress.crt
update-ca-certificates >/dev/null
test -f /etc/ssl/certs/ca-certificates.crt
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt "$tmp" >/dev/null
test "$(stat -c '%u:%g:%a' /usr/local/share/ca-certificates/openbot-project-egress.crt)" = 0:0:644`;
      await this.command(['shell', id, '--', 'sudo', '-n', 'sh', '-eu', '-c', script, 'openbot-trust', certificate.toString('base64'), digest]);
      return { installed: true, fingerprint: digest };
    }, 300000);
  }
  async ensure(installation: string, project: string, profile: BusinessWorkspace) {
    if (profile.kind !== "vm") throw new Error("This project does not declare a VM.");
    if (!/^https:\/\//.test(profile.image) || !/^sha256:[a-f0-9]{64}$/.test(profile.imageDigest)) throw new Error("A pinned VM image is required.");
    const id = this.id(installation, project);
    return registryTransaction(this.lockDirectory(id), async () => {
    const existing = await this.check(id);
    if (existing.ready) return existing;
    if (existing.status === "IsolationUnverified") {
      await this.configureIsolation(id);
      return this.check(id);
    }
    if (existing.status === "Unreachable") return existing;
    if (existing.status !== "Missing") {
      await this.command(["start", "--tty=false", id]);
      await this.configureIsolation(id);
      return this.check(id);
    }
    const directory = await mkdtemp(join(tmpdir(), "openbot-lima-profile-"));
    try {
      const config = join(directory, "profile.yaml");
      await writeFile(config, JSON.stringify({
        vmType: process.platform === "darwin" ? "vz" : "qemu",
        ...(process.platform === "darwin" ? { networkOpts: { hostLoopback: false } } : {}),
        images: [{ location: profile.image, arch: process.arch === "arm64" ? "aarch64" : "x86_64", digest: profile.imageDigest }],
        cpus: profile.cpus, memory: profile.memoryMb + "MiB", disk: profile.diskGb + "GiB",
        mounts: [], containerd: { system: false, user: false },
        // Cover loopback-bound guest services as well as wildcard listeners.
        portForwards: [{ guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', guestPortRange: [1, 65535], ignore: true }],
        hostResolver: { enabled: false },
      }));
      await this.command(["start", "--tty=false", "--plain", "--name=" + id, config]);
      await this.configureIsolation(id);
      return this.check(id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    }, 300000);
  }
  private actionFile(id: string, operationKey: string) {
    if (!/^obot-[a-f0-9]{24}$/.test(id) || typeof operationKey !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(operationKey)) throw new Error("Invalid action binding.");
    const homeId = createHash("sha256").update(this.providerHome).digest("hex").slice(0, 16);
    return join(dirname(this.providerHome), ".openbot-vm-state", homeId, id, createHash("sha256").update(operationKey).digest("hex") + ".json");
  }
  private async readAction(file: string): Promise<any | undefined> {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  private async saveAction(file: string, record: object) {
    const directory = dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + Math.random().toString(16).slice(2);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async recoverAction(id: string, operationKey: string, file: string, record: { digest: string }) {
    // A guest receipt is written only after the command finishes. If the guest
    // or connection is unavailable, its absence is not proof of non-execution.
    const receipt = createHash("sha256").update(operationKey).digest("hex");
    try {
      const output = await this.command(["shell", id, "--", "sh", "-c", 'dir="$HOME/.openbot/actions/$1"; test -f "$dir/exit" && test -f "$dir/stdout" && test -f "$dir/stderr" && test -f "$dir/digest" && test "$(cat "$dir/digest")" = "$2" || exit 1; cat "$dir/exit"; printf "\\n"; base64 < "$dir/stdout" | tr -d "\\n"; printf "\\n"; base64 < "$dir/stderr" | tr -d "\\n"; printf "\\n"', "openbot-reconcile", receipt, record.digest]);
      const lines = output.stdout.split("\n");
      if (lines.length !== 4 || !/^\d+$/.test(lines[0]) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(lines[1]) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(lines[2])) return { status: "uncertain" as const };
      const result = { status: "completed" as const, exitCode: Number(lines[0]), stdout: Buffer.from(lines[1], "base64").toString(), stderr: Buffer.from(lines[2], "base64").toString() };
      if (result.exitCode > 255) return { status: "uncertain" as const };
      await this.saveAction(file, { ...result, digest: record.digest });
      return result;
    } catch { return { status: "uncertain" as const }; }
  }
  async reconcileAction(id: string, operationKey: string) {
    const file = this.actionFile(id, operationKey);
    return registryTransaction(this.lockDirectory(id), async () => {
      const record = await this.readAction(file);
      if (!record) return { status: "unknown" };
      if (record.status !== "completed") return this.recoverAction(id, operationKey, file, record);
      return { status: "completed", exitCode: record.exitCode, stdout: record.stdout, stderr: record.stderr };
    }, 300000);
  }
  async runAction(id: string, operationKey: string, argv: string[], qa?: { revision: string }) {
    const file = this.actionFile(id, operationKey);
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 128 || argv.some(value => typeof value !== "string" || value.includes("\0") || value.length > 8192) || !argv[0]) throw new Error("Invalid action arguments.");
    if (qa && (typeof qa.revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(qa.revision))) throw new Error('Invalid QA candidate revision.');
    const digest = createHash("sha256").update(JSON.stringify(qa ? { argv, qa } : argv)).digest("hex");
    return registryTransaction(this.lockDirectory(id), async () => {
      if (!await this.verifyIsolation(id)) throw new Error("Project network isolation is unavailable.");
      const previous = await this.readAction(file);
      if (previous) {
        if (previous.digest !== digest) throw new Error("Operation key already used with different arguments.");
        if (previous.status !== "completed") return this.recoverAction(id, operationKey, file, previous);
        return { status: "completed", exitCode: previous.exitCode, stdout: previous.stdout, stderr: previous.stderr };
      }
      await this.saveAction(file, { status: "running", digest });
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        const marker = "openbot-exit-" + randomUUID() + ":";
        const receipt = createHash("sha256").update(operationKey).digest("hex");
        const script = qa ? guestQaAction : `cd "$HOME/project" || exit 125
marker="$1"; receipt="$2"; digest="$3"; shift 3
base="$HOME/.openbot/actions"; dir="$base/$receipt"; tmp="$base/$receipt.pending"
umask 077
mkdir -p "$base" || exit 125
test ! -e "$dir" && test ! -e "$tmp" || exit 125
mkdir "$tmp" || exit 125
printf "%s" "$digest" >"$tmp/digest" || exit 125
sudo -n ip netns exec openbot-project unshare --mount --propagation private sh -c 'mount -t tmpfs -o nosuid,nodev,mode=755 tmpfs /run || exit 125; exec runuser -u openbot-project -- setpriv --no-new-privs -- "$@"' openbot-exec "$@" >"$tmp/stdout" 2>"$tmp/stderr"
code=$?
printf "%s" "$code" >"$tmp/exit" || exit 125
mv "$tmp" "$dir" || exit 125
sync || exit 125
cat "$dir/stdout"
cat "$dir/stderr" >&2
printf "\\n%s%s\\n" "$marker" "$code" >&2`;
        const output = await this.command(["shell", id, "--", "sh", "-c", script, "openbot-action", marker, receipt, digest, ...(qa ? [qa.revision] : []), ...argv]);
        const index = output.stderr.lastIndexOf("\n" + marker);
        if (index < 0) return { status: "uncertain" };
        const suffix = output.stderr.slice(index + marker.length + 1);
        if (!/^\d+\n$/.test(suffix)) return { status: "uncertain" };
        result = { stdout: output.stdout, stderr: output.stderr.slice(0, index), exitCode: Number(suffix.trim()) };
      } catch { return { status: "uncertain" }; }
      await this.saveAction(file, { status: "completed", digest, ...result });
      return { status: "completed", ...result };
    }, 300000);
  }
  async importSource(id: string, root: string, source: string, replacement?: { expectedRevision: string }) {
    if (!/^obot-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid project VM.");
    if (replacement && (typeof replacement.expectedRevision !== "string" || !/^[a-f0-9]{40,64}$/.test(replacement.expectedRevision))) throw new Error("Invalid source revision.");
    return registryTransaction(this.lockDirectory(id), async () => {
    const snapshot = await captureSource(root, source);
    try {
      const preserve = `if [ -e "$HOME/project" ] && [ -f "$HOME/.openbot/source-revision" ] && [ "$(cat "$HOME/.openbot/source-revision")" != "$1" ]; then
  if [ "$2" != replace ] || [ "$(cat "$HOME/.openbot/source-revision")" != "$3" ]; then exit 1; fi
  mkdir -p "$HOME/.openbot/backups"
  backup=$(mktemp -d "$HOME/.openbot/backups/source-XXXXXXXX")
  mv "$HOME/project" "$backup/project" 2>/dev/null || sudo -n mv "$HOME/project" "$backup/project"
fi
if [ ! -e "$HOME/project" ] && [ -f "$HOME/.openbot/source-revision" ] && [ "$(cat "$HOME/.openbot/source-revision")" != "$1" ]; then
  if [ "$2" != replace ] || [ "$(cat "$HOME/.openbot/source-revision")" != "$3" ]; then exit 1; fi
fi`;
      const guestCommand = snapshot.bundle
        ? `set -eu
mkdir -p "$HOME/.openbot"
file="$HOME/.openbot/source-$1.bundle"
stage="$HOME/.openbot/import-$1"
cat > "$file"
${preserve}
if [ -e "$HOME/project" ]; then
  if [ ! -f "$HOME/.openbot/source-revision" ] && [ -f "$HOME/.openbot/source-revision.pending" ]; then
    test "$(cat "$HOME/.openbot/source-revision.pending")" = "$1"
    mv "$HOME/.openbot/source-revision.pending" "$HOME/.openbot/source-revision"
  fi
  test -f "$HOME/.openbot/source-revision"
  test "$(cat "$HOME/.openbot/source-revision")" = "$1"
else
  rm -rf "$stage"
  git clone --no-local "$file" "$stage"
  test "$(git -C "$stage" rev-parse HEAD)" = "$1"
  printf '%s' "$1" > "$HOME/.openbot/source-revision.pending"
  mv "$stage" "$HOME/project"
  mv "$HOME/.openbot/source-revision.pending" "$HOME/.openbot/source-revision"
fi
rm -f "$file"
sync`
        : `set -eu
mkdir -p "$HOME/.openbot"
stage="$HOME/.openbot/import-$1"
${preserve}
if [ -e "$HOME/project" ]; then
  if [ ! -f "$HOME/.openbot/source-revision" ] && [ -f "$HOME/.openbot/source-revision.pending" ]; then
    test "$(cat "$HOME/.openbot/source-revision.pending")" = "$1"
    mv "$HOME/.openbot/source-revision.pending" "$HOME/.openbot/source-revision"
  fi
  test -f "$HOME/.openbot/source-revision"
  test "$(cat "$HOME/.openbot/source-revision")" = "$1"
  cat >/dev/null
else
  rm -rf "$stage"
  mkdir "$stage"
  tar -xf - -C "$stage"
  printf '%s' "$1" > "$HOME/.openbot/source-revision.pending"
  mv "$stage" "$HOME/project"
  mv "$HOME/.openbot/source-revision.pending" "$HOME/.openbot/source-revision"
fi
sync`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.binary, ["shell", id, "--", "sh", "-c", guestCommand, "workspace-import", snapshot.digest, replacement ? "replace" : "initial", replacement?.expectedRevision ?? ""], { stdio: ["pipe", "ignore", "pipe"] });
        const stream = createReadStream(snapshot.bundle ?? snapshot.archive);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 240000);
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        stream.once("error", error => { child.kill("SIGKILL"); reject(error); });
        child.stdin.once("error", error => { stream.destroy(); child.kill("SIGKILL"); reject(error); });
        child.stderr.resume();
        stream.pipe(child.stdin);
        child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error("Guest source import failed.")); });
      });
      await this.prepareProject(id);
      return { revision: snapshot.digest, files: snapshot.files, excludedPaths: snapshot.excludedPaths ?? [], excludesUncommittedChanges: snapshot.excludesUncommittedChanges ?? false };
    } finally { await snapshot.cleanup(); }
    }, 300000);
  }
}
