#!/bin/sh
# Run ONLY inside a disposable root Linux container with sudo and systemd installed.
# No shutdown executable is ever invoked; sudo -l only checks permission.
set -eu
[ "${COMPUTERBUG_DISPOSABLE_SETUP_TEST:-}" = 1 ] || { echo 'Requires disposable test container' >&2; exit 1; }
setup=${1:-/setup}
# Clear identity fixtures left by an interrupted previous run.
rm -f /usr/sbin/uname /usr/sbin/dscl
expect_failure() {
  if "$@" >/tmp/setup-failure.log 2>&1; then echo "Unexpected success: $*" >&2; exit 1; fi
}
id bugtest >/dev/null 2>&1 || useradd -m bugtest
id otheruser >/dev/null 2>&1 || useradd -m otheruser
rule=/etc/sudoers.d/computerbug-shutdown-bugtest
for platform in Linux Darwin; do
  if [ "$platform" = Darwin ]; then
    # Exercise the macOS branch with real sudo/visudo in Linux, mocking only OS identity.
    printf '#!/bin/sh\necho Darwin\n' > /usr/sbin/uname
    printf '#!/bin/sh\n[ "$1" = . ] && [ "$2" = -read ] && [ "$3" = /Users/bugtest ]\n' > /usr/sbin/dscl
    # A sentinel fails loudly if a test accidentally attempts power-off.
    printf '#!/bin/sh\necho "Shutdown must never execute in setup tests" >&2\nexit 99\n' > /sbin/shutdown
    chmod 755 /usr/sbin/uname /usr/sbin/dscl /sbin/shutdown
    command='/sbin/shutdown -h now'
  else
    command='/usr/bin/systemctl poweroff --force'
  fi
  sh "$setup/install-shutdown.sh" bugtest
  [ "$(stat -c '%u:%g:%a' "$rule")" = 0:0:440 ]
  [ "$(cat "$rule")" = "bugtest ALL=(root) NOPASSWD: $command" ]
  # Deliberate word splitting supplies the known fixed command and arguments.
  sudo -u bugtest sudo -n -l -- $command >/dev/null
  expect_failure sudo -n -l -U otheruser -- $command
  expect_failure sudo -n -l -U bugtest -- $command extra
  expect_failure sh "$setup/install-shutdown.sh" bugtest
  [ -f "$rule" ]
  sh "$setup/uninstall-shutdown.sh" bugtest
  [ ! -e "$rule" ]
  expect_failure sudo -n -l -U bugtest -- $command
  sh "$setup/uninstall-shutdown.sh" bugtest
  expect_failure sh "$setup/install-shutdown.sh" 'bad,user'
  expect_failure sh "$setup/install-shutdown.sh" root
  expect_failure sh "$setup/install-shutdown.sh" missinguser
  # Missing active includedir must roll back the new rule.
  cp /etc/sudoers /tmp/sudoers.original
  sed -i '\|^[#@]includedir /etc/sudoers.d|d' /etc/sudoers
  expect_failure sh "$setup/install-shutdown.sh" bugtest
  [ ! -e "$rule" ]
  cp /tmp/sudoers.original /etc/sudoers
  # A missing validation prerequisite fails before creating permission.
  mv /usr/sbin/visudo /usr/sbin/visudo.disabled
  expect_failure sh "$setup/install-shutdown.sh" bugtest
  [ ! -e "$rule" ]
  mv /usr/sbin/visudo.disabled /usr/sbin/visudo
  echo "$platform setup, exact permission, rollback, and uninstall checks passed"
done
