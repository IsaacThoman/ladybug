#!/bin/sh
# Shared administrator setup implementation; never executes a shutdown command.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
fail() { echo "Computerbug shutdown setup: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as administrator with sudo"
[ "$#" = 2 ] || fail "expected install/uninstall and a local username"
action=$1
user=$2
# Keep sudoers names and filenames free of metacharacters.
case "$user" in ''|*[!a-zA-Z0-9_-]*|-*) fail "unsupported local username" ;; esac
uid=$(id -u "$user") || fail "local user does not exist"
[ "$uid" != 0 ] || fail "select the non-root user running Computerbug"
case "$(uname -s)" in
  Linux)
    awk -F: -v name="$user" '$1 == name { found=1 } END { exit !found }' /etc/passwd || fail "local user not found"
    command='/usr/bin/systemctl poweroff --force'
    binary=/usr/bin/systemctl
    ;;
  Darwin)
    dscl . -read "/Users/$user" UniqueID >/dev/null || fail "local user not found"
    command='/sbin/shutdown -h now'
    binary=/sbin/shutdown
    ;;
  *) fail "only Linux and macOS are supported" ;;
esac
[ -x /usr/sbin/visudo ] || fail "install sudo (visudo is missing)"
[ -x /usr/bin/sudo ] || fail "install sudo (/usr/bin/sudo is missing)"
[ -d /etc/sudoers.d ] && [ ! -L /etc/sudoers.d ] || fail "/etc/sudoers.d must be a real include directory"
rule=/etc/sudoers.d/computerbug-shutdown-$user
/usr/sbin/visudo -c >/dev/null || fail "existing sudoers configuration is invalid"
case "$action" in
  install)
    [ -x "$binary" ] || fail "shutdown executable is missing: $binary"
    [ ! -e "$rule" ] && [ ! -L "$rule" ] || fail "rule already exists; uninstall it first"
    # The temporary filename contains a dot, so sudo's includedir ignores it.
    temp=$(mktemp /etc/sudoers.d/.computerbug-XXXXXX)
    installed=false
    complete=false
    cleanup() {
      rm -f "$temp"
      if [ "$installed" = true ] && [ "$complete" = false ]; then rm -f "$rule"; fi
    }
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    printf '%s ALL=(root) NOPASSWD: %s\n' "$user" "$command" > "$temp"
    chown 0:0 "$temp"
    chmod 0440 "$temp"
    /usr/sbin/visudo -cf "$temp" >/dev/null || fail "generated rule is invalid"
    mv "$temp" "$rule"
    installed=true
    # visudo's full validation lists parsed includes. This proves this exact rule is active.
    validation=$(LC_ALL=C /usr/sbin/visudo -c) || fail "sudoers validation failed"
    printf '%s\n' "$validation" | grep -F "$rule: parsed OK" >/dev/null || fail "/etc/sudoers.d is not active in sudoers"
    # -l checks authorization only. It never executes the command.
    case "$binary" in
      /usr/bin/systemctl) /usr/bin/sudo -u "$user" /usr/bin/sudo -n -l -- "$binary" poweroff --force >/dev/null ;;
      /sbin/shutdown) /usr/bin/sudo -u "$user" /usr/bin/sudo -n -l -- "$binary" -h now >/dev/null ;;
    esac || fail "effective shutdown permission check failed"
    complete=true
    echo "Installed shutdown permission for $user. No shutdown was executed."
    ;;
  uninstall)
    [ ! -L "$rule" ] || fail "refusing a symbolic-link rule"
    rm -f "$rule"
    /usr/sbin/visudo -c >/dev/null || fail "sudoers validation failed after removal"
    echo "Removed Computerbug shutdown permission for $user."
    ;;
  *) fail "unknown action" ;;
esac
