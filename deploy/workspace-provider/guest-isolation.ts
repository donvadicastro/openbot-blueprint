/** Static root-owned guest setup. Project commands never receive this authority. */
export const guestIsolationSetup = `
id -u openbot-project >/dev/null 2>&1 || useradd --create-home --shell /bin/sh openbot-project
ip netns exec openbot-project true >/dev/null 2>&1 || ip netns add openbot-project
ip -n openbot-project link set lo up
`;

/** Fail closed if the namespace has external interfaces/routes or the user has privilege. */
export const guestIsolationVerify = `
id -u openbot-project >/dev/null
test "$(id -u openbot-project)" -ge 1000
command -v unshare >/dev/null
command -v mount >/dev/null
test "$(ip -n openbot-project -o link show | wc -l | tr -d ' ')" = 1
ip -n openbot-project -o link show | grep -Eq '^[0-9]+: lo:.*UP'
test -z "$(ip -n openbot-project -4 route show)"
test -z "$(ip -n openbot-project -6 route show)"
test "$(ip netns exec openbot-project runuser -u openbot-project -- sh -c 'awk "/^CapEff:/ {print \\$2}" /proc/self/status')" = 0000000000000000
if ip netns exec openbot-project runuser -u openbot-project -- sudo -n true >/dev/null 2>&1; then exit 1; fi
`;

export const guestProjectAccess = `
chmod o+x "$HOME"
sudo -n chown -R openbot-project:openbot-project "$HOME/project"
`;
