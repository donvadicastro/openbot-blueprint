/**
 * Guest script for a QA action. Its arguments are marker, receipt, digest,
 * exact Git commit, then the command argv. The command itself runs as a
 * separate unprivileged user in a private PID/mount/network namespace and a
 * chroot containing only a verified read-only snapshot, /usr, /proc and /tmp.
 */
export const guestQaAction = `
marker="$1"; receipt="$2"; digest="$3"; revision="$4"; shift 4
base="$HOME/.openbot/actions"; dir="$base/$receipt"; tmp="$base/$receipt.pending"
umask 077
mkdir -p "$base" || exit 125
test ! -e "$dir" && test ! -e "$tmp" || exit 125
mkdir "$tmp" || exit 125
printf "%s" "$digest" >"$tmp/digest" || exit 125
run_qa() (
  set -eu
  source="$HOME/project"
  stage=$(mktemp -d "$HOME/.openbot/qa-XXXXXXXX")
  cleanup() { sudo -n rm -rf -- "$stage"; }
  trap cleanup EXIT HUP INT TERM
  mkdir "$stage/snapshot" "$stage/root" "$stage/home"
  tree=$(sudo -n ip netns exec openbot-project runuser -u openbot-project -- env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$source" rev-parse --verify "$revision^{tree}")
  sudo -n ip netns exec openbot-project runuser -u openbot-project -- env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C "$source" archive --format=tar "$revision" >"$stage/source.tar"
  tar -xf "$stage/source.tar" -C "$stage/snapshot"
  # Relative links are useful in real repositories. Every link must resolve
  # lexically within the snapshot; checking each link also covers link chains.
  find "$stage/snapshot" -type l -exec sh -eu -c '
    root=$(realpath -ms -- "$1"); shift
    for link do
      target=$(readlink -- "$link")
      case "$target" in /*) exit 1;; esac
      resolved=$(realpath -ms -- "$(dirname -- "$link")/$target")
      case "$resolved" in "$root"|"$root"/*) ;; *) exit 1;; esac
    done
  ' openbot-qa-links "$stage/snapshot" {} +
  env HOME="$stage/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git init -q --bare "$stage/verify.git"
  env HOME="$stage/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_INDEX_FILE="$stage/index" git --git-dir="$stage/verify.git" --work-tree="$stage/snapshot" add -A -f
  actual=$(env HOME="$stage/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_INDEX_FILE="$stage/index" git --git-dir="$stage/verify.git" write-tree)
  test "$actual" = "$tree"
  sudo -n chown -R root:root "$stage/snapshot"
  sudo -n chmod -R a+rX,a-w "$stage/snapshot"
  root="$stage/root"
  mkdir "$root/usr" "$root/work" "$root/proc" "$root/tmp" "$root/dev" "$root/etc"
  chmod 755 "$root" "$root/usr" "$root/work" "$root/proc" "$root/tmp" "$root/dev" "$root/etc"
  ln -s usr/bin "$root/bin"
  ln -s usr/sbin "$root/sbin"
  ln -s usr/lib "$root/lib"
  if [ -e /usr/lib64 ]; then ln -s usr/lib64 "$root/lib64"; fi
  touch "$root/dev/null" "$root/dev/zero" "$root/dev/urandom"
  uid=$(id -u openbot-qa); gid=$(id -g openbot-qa)
  printf 'openbot-qa:x:%s:%s:QA:/tmp:/usr/sbin/nologin\\n' "$uid" "$gid" >"$root/etc/passwd"
  printf 'openbot-qa:x:%s:\\n' "$gid" >"$root/etc/group"
  chmod 644 "$root/etc/passwd" "$root/etc/group"
  sudo -n ip netns exec openbot-project unshare --mount --pid --fork --propagation private sh -eu -c '
    root="$1"; snapshot="$2"; uid="$3"; gid="$4"; shift 4
    mount --bind /usr "$root/usr"
    mount -o remount,bind,ro,nosuid,nodev "$root/usr"
    mount --bind "$snapshot" "$root/work"
    mount -o remount,bind,ro,nosuid,nodev "$root/work"
    mount -t tmpfs -o nosuid,nodev,mode=1777 tmpfs "$root/tmp"
    mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
    mount -o remount,ro,nosuid,nodev,noexec "$root/proc"
    for device in null zero urandom; do mount --bind "/dev/$device" "$root/dev/$device"; done
    exec chroot "$root" /usr/bin/setpriv --reuid="$uid" --regid="$gid" --clear-groups --no-new-privs \\
      /usr/bin/env -i HOME=/tmp PATH=/usr/bin:/bin TMPDIR=/tmp /usr/bin/sh -c "cd /work; exec \\\"\\$@\\\"" openbot-qa "$@"
  ' openbot-qa-sandbox "$root" "$stage/snapshot" "$uid" "$gid" "$@"
)
run_qa "$@" >"$tmp/stdout" 2>"$tmp/stderr"
code=$?
printf "%s" "$code" >"$tmp/exit" || exit 125
mv "$tmp" "$dir" || exit 125
sync || exit 125
cat "$dir/stdout"
cat "$dir/stderr" >&2
printf "\\n%s%s\\n" "$marker" "$code" >&2`;
