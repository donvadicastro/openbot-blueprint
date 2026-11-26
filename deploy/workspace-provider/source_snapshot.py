#!/usr/bin/env python3
"""Create a bounded source archive from directory descriptors, never path walks."""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 20_000
EXCLUDED = {".git", "node_modules", ".env", ".openbot"}
FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
DIR_FLAGS = FLAGS | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
FILE_FLAGS = FLAGS | getattr(os, "O_NOFOLLOW", 0)


def fail(message):
    raise RuntimeError(message)


def open_child_directory(parent, name):
    try:
        return os.open(name, DIR_FLAGS, dir_fd=parent)
    except OSError:
        fail("Source changed during snapshot or contains an unsupported symbolic link.")


def open_source(root_path, source_path):
    root_real = os.path.realpath(root_path)
    source_real = os.path.realpath(source_path)
    try:
        relative = os.path.relpath(source_real, root_real)
        if os.path.commonpath((root_real, source_real)) != root_real:
            fail("Source is outside the approved projects folder.")
    except ValueError:
        fail("Source is outside the approved projects folder.")
    try:
        root_fd = os.open(root_real, DIR_FLAGS)
    except OSError:
        fail("Choose an accessible approved projects folder.")
    current = os.dup(root_fd)
    try:
        if relative != ".":
            for component in relative.split(os.sep):
                if component in ("", ".", ".."):
                    fail("Source is outside the approved projects folder.")
                child = open_child_directory(current, component)
                os.close(current)
                current = child
        return root_fd, current, source_real
    except BaseException:
        os.close(current)
        os.close(root_fd)
        raise


def excluded(name):
    return name in EXCLUDED or name.startswith(".env.")


def mode(stat_result):
    return stat.S_IMODE(stat_result.st_mode) & 0o777


def stable_file(before, after):
    return (stat.S_ISREG(after.st_mode) and before.st_dev == after.st_dev and
            before.st_ino == after.st_ino and before.st_size == after.st_size and
            before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns)


def copy_git_metadata(source_fd, target, counters):
    """Copy .git through openat-style descriptor traversal, rejecting indirection."""
    try:
        info = os.stat(".git", dir_fd=source_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode):
        fail("The source Git metadata is not a supported file or directory.")
    if not stat.S_ISDIR(info.st_mode):
        return False
    git_fd = open_child_directory(source_fd, ".git")
    try:
        for forbidden in ("commondir",):
            try:
                os.stat(forbidden, dir_fd=git_fd, follow_symlinks=False)
                fail("This Git repository uses external metadata and cannot be imported safely.")
            except FileNotFoundError:
                pass
        try:
            objects_fd = open_child_directory(git_fd, "objects")
            try:
                info_fd = open_child_directory(objects_fd, "info")
                try:
                    try:
                        os.stat("alternates", dir_fd=info_fd, follow_symlinks=False)
                        fail("This Git repository uses external objects and cannot be imported safely.")
                    except FileNotFoundError:
                        pass
                finally:
                    os.close(info_fd)
            except FileNotFoundError:
                pass
            finally:
                os.close(objects_fd)
        except FileNotFoundError:
            fail("The selected folder is not a complete Git repository.")

        os.mkdir(target, 0o700)
        copy_tree(git_fd, target, "", counters, reject_links=True)
    finally:
        os.close(git_fd)

    config = os.path.join(target, "config")
    try:
        original = open(config, "r", encoding="utf-8", errors="strict").read()
    except OSError:
        original = ""
    if re.search(r"(?im)^\s*\[\s*include(?:if)?\s*\]", original):
        fail("This Git repository uses included configuration and cannot be imported safely.")
    extensions = re.findall(r"(?im)^\s*\[\s*extensions\s*\]\s*(?:\r?\n)([^\[]*)", original)
    object_format = "sha1"
    for block in extensions:
        for line in block.splitlines():
            match = re.match(r"\s*objectformat\s*=\s*(sha1|sha256)\s*$", line, re.I)
            if match:
                object_format = match.group(1).lower()
            elif line.strip() and not line.lstrip().startswith(("#", ";")):
                fail("This Git repository uses unsupported extensions and cannot be imported safely.")
    with open(config, "w", encoding="utf-8") as output:
        version = "1" if object_format == "sha256" else "0"
        output.write(f"[core]\n\trepositoryformatversion = {version}\n\tfilemode = true\n\tbare = false\n\tfsmonitor = false\n")
        if object_format == "sha256":
            output.write("[extensions]\n\tobjectFormat = sha256\n")
    return True


def copy_tree(source_fd, destination, relative_path, counters, reject_links, excluded_paths=None):
    for name in sorted(os.listdir(source_fd)):
        if excluded(name):
            if excluded_paths is not None and name != ".git":
                excluded_paths.append(f"{relative_path}/{name}" if relative_path else name)
            continue
        item_path = f"{relative_path}/{name}" if relative_path else name
        info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            if reject_links:
                fail("The source Git metadata contains a symbolic link.")
            link = os.readlink(name, dir_fd=source_fd)
            os.symlink(link, os.path.join(destination, name))
            continue
        if stat.S_ISDIR(info.st_mode):
            child = open_child_directory(source_fd, name)
            try:
                os.mkdir(os.path.join(destination, name), mode(info))
                copy_tree(child, os.path.join(destination, name), item_path, counters, reject_links, excluded_paths)
            finally:
                os.close(child)
            continue
        if not stat.S_ISREG(info.st_mode):
            fail("Source contains an unsupported special file.")
        counters["files"] += 1
        counters["bytes"] += info.st_size
        if counters["files"] > MAX_FILES or counters["bytes"] > MAX_BYTES:
            fail("Source snapshot exceeds the pilot size limit.")
        try:
            fd = os.open(name, FILE_FLAGS, dir_fd=source_fd)
        except OSError:
            fail("Source changed during snapshot or contains an unsupported symbolic link.")
        try:
            opened = os.fstat(fd)
            if not stable_file(info, opened):
                fail("Source changed during snapshot.")
            output_path = os.path.join(destination, name)
            with os.fdopen(fd, "rb", closefd=False) as input_file, open(output_path, "xb") as output_file:
                shutil.copyfileobj(input_file, output_file, 64 * 1024)
            if not stable_file(info, os.fstat(fd)):
                fail("Source changed during snapshot.")
            os.chmod(output_path, mode(info))
        finally:
            os.close(fd)


def git_snapshot(source_fd, temporary, counters):
    try:
        git_stat = os.stat(".git", dir_fd=source_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(git_stat.st_mode):
        fail("The source Git metadata is not a supported file or directory.")
    if not stat.S_ISDIR(git_stat.st_mode):
        return None
    repo = os.path.join(temporary, "repo")
    os.mkdir(repo, 0o700)
    if not copy_git_metadata(source_fd, os.path.join(repo, ".git"), counters):
        return None
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": temporary,
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0"}

    def git(args):
        try:
            return subprocess.run(["git", "-C", repo, *args], env=env, check=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120).stdout
        except (OSError, subprocess.SubprocessError):
            fail("The selected Git repository could not be read safely.")

    revision = git(["rev-parse", "--verify", "HEAD^{commit}"]).decode().strip()
    if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", revision):
        fail("The selected Git repository has an invalid committed revision.")
    tree = git(["ls-tree", "-l", "-r", "-z", revision])
    entries = [item for item in tree.split(b"\0") if item]
    total = 0
    for entry in entries:
        if re.match(rb"^(120000|160000) ", entry):
            fail("The committed source contains a symbolic link or submodule.")
        match = re.match(rb"^\d+ blob [a-f0-9]+\s+(\d+)\t", entry)
        if match:
            total += int(match.group(1))
    if len(entries) > MAX_FILES or total > MAX_BYTES:
        fail("Source snapshot exceeds the pilot size limit.")
    archive = os.path.join(temporary, "source.tar")
    bundle = os.path.join(temporary, "source.bundle")
    git(["archive", "--format=tar", "--output=" + archive, revision])
    git(["bundle", "create", bundle, "HEAD"])
    if os.path.getsize(bundle) > MAX_BYTES:
        fail("Source Git history exceeds the pilot size limit.")
    try:
        subprocess.run(["git", "-C", repo, "bundle", "verify", bundle], env=env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    except (OSError, subprocess.SubprocessError):
        fail("The selected Git repository could not be read safely.")
    excluded_paths = []
    copy_tree(source_fd, repo, "", counters, reject_links=False, excluded_paths=excluded_paths)
    status = git(["status", "--porcelain", "--untracked-files=normal"])
    return {"archive": archive, "bundle": bundle, "digest": revision,
            "files": len(entries), "bytes": total, "excludedPaths": excluded_paths,
            "excludesUncommittedChanges": bool(status.strip() or excluded_paths)}


def plain_snapshot(source_fd, source_real, temporary):
    archive_path = os.path.join(temporary, "source.tar")
    digest = hashlib.sha256()
    counters = {"files": 0, "bytes": 0}
    excluded_paths = []
    with tarfile.open(archive_path, "w", format=tarfile.PAX_FORMAT) as archive:
        root_entry = tarfile.TarInfo(".")
        root_entry.type = tarfile.DIRTYPE
        root_entry.mode = 0o755
        root_entry.mtime = 0
        archive.addfile(root_entry)

        def visit(directory_fd, relative_path):
            for name in sorted(os.listdir(directory_fd)):
                item_path = f"{relative_path}/{name}" if relative_path else name
                if excluded(name):
                    excluded_paths.append(item_path)
                    continue
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                tar_name = "./" + item_path
                if stat.S_ISLNK(info.st_mode):
                    fail("Source snapshot contains a symbolic link. Resolve it within the source before importing.")
                if stat.S_ISDIR(info.st_mode):
                    child = open_child_directory(directory_fd, name)
                    try:
                        entry = tarfile.TarInfo(tar_name + "/")
                        entry.type = tarfile.DIRTYPE
                        entry.mode = mode(info)
                        entry.mtime = 0
                        archive.addfile(entry)
                        visit(child, item_path)
                    finally:
                        os.close(child)
                    continue
                if not stat.S_ISREG(info.st_mode):
                    fail("Source contains an unsupported special file.")
                counters["files"] += 1
                counters["bytes"] += info.st_size
                if counters["files"] > MAX_FILES or counters["bytes"] > MAX_BYTES:
                    fail("Source snapshot exceeds the pilot size limit.")
                try:
                    fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
                except OSError:
                    fail("Source changed during snapshot or contains an unsupported symbolic link.")
                try:
                    opened = os.fstat(fd)
                    if not stable_file(info, opened):
                        fail("Source changed during snapshot.")
                    digest.update(item_path.encode("utf-8", "surrogateescape"))
                    digest.update(b"\0")
                    digest.update(str(mode(info)).encode())
                    digest.update(b"\0")
                    digest.update(str(info.st_size).encode())
                    digest.update(b"\0")
                    entry = tarfile.TarInfo(tar_name)
                    entry.size = info.st_size
                    entry.mode = mode(info)
                    entry.mtime = 0
                    with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, dir=temporary) as spool, os.fdopen(fd, "rb", closefd=False) as input_file:
                        remaining = info.st_size
                        while remaining:
                            block = input_file.read(min(64 * 1024, remaining))
                            if not block:
                                fail("Source changed during snapshot.")
                            remaining -= len(block)
                            digest.update(block)
                            spool.write(block)
                        if input_file.read(1) or not stable_file(info, os.fstat(fd)):
                            fail("Source changed during snapshot.")
                        spool.seek(0)
                        archive.addfile(entry, spool)
                finally:
                    os.close(fd)

        visit(source_fd, "")
    return {"archive": archive_path, "digest": digest.hexdigest(), "files": counters["files"],
            "bytes": counters["bytes"], "excludedPaths": excluded_paths,
            "excludesUncommittedChanges": False}


def capture(root_path, source_path, temporary):
    root_fd, source_fd, source_real = open_source(root_path, source_path)
    try:
        result = git_snapshot(source_fd, temporary, {"files": 0, "bytes": 0})
        return result if result is not None else plain_snapshot(source_fd, source_real, temporary)
    finally:
        os.close(source_fd)
        os.close(root_fd)


if __name__ == "__main__":
    try:
        print(json.dumps(capture(sys.argv[1], sys.argv[2], sys.argv[3])))
    except Exception as error:
        print(str(error) or "Source snapshot failed.", file=sys.stderr)
        sys.exit(1)
