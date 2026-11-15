#!/bin/sh
set -eu
[ "$#" = 1 ] || { echo "Usage: sudo sh $0 LOCAL_USERNAME" >&2; exit 1; }
exec /bin/sh "$(dirname "$0")/shutdown-setup.sh" uninstall "$1"
