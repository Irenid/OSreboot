#!/usr/bin/env bash
# A series of demo runs for measurements. Each run starts osreboot-wipe
# --apply on the test system through its SSH tunnel and waits until the
# restored system sends heartbeats again. The server writes every run to
# data/outages.csv; dist/outage-stats.js sums them up.
#
#   scripts/run-series.sh RUNS
#
# Environment:
#   OSREBOOT_URL       server address, e.g. https://osreboot.example.org
#   OSREBOOT_SSH       the test system through the tunnel, e.g. root@osreboot.example.org
#   OSREBOOT_SSH_PORT  2221 by default
#   OSREBOOT_DEVICE    device id from config/devices.json, laptop by default
#   PAUSE_S            seconds between runs, 60 by default
#   TIMEOUT_S          seconds one run may take, 900 by default
#
# The series stops at the first run that does not end with the restored
# system online: a failed recovery is never wiped again. Needs ssh, curl, jq.
set -euo pipefail

runs=${1:?usage: run-series.sh RUNS}
: "${OSREBOOT_URL:?set OSREBOOT_URL}"
: "${OSREBOOT_SSH:?set OSREBOOT_SSH}"
port=${OSREBOOT_SSH_PORT:-2221}
device=${OSREBOOT_DEVICE:-laptop}
pause=${PAUSE_S:-60}
timeout=${TIMEOUT_S:-900}

die() {
	echo "run-series: $*" >&2
	exit 1
}

test_system() {
	ssh -p "$port" -o BatchMode=yes -o ConnectTimeout=10 \
		-o ServerAliveInterval=5 -o ServerAliveCountMax=2 "$OSREBOOT_SSH" "$@"
}

# Applies a jq filter to /api/state; $id is the device, $since a time in ms.
state() {
	curl -fsS --max-time 10 "${OSREBOOT_URL%/}/api/state" |
		jq -r --arg id "$device" --argjson since "${2:-0}" "$1"
}
# shellcheck disable=SC2016 # $id is a jq variable, not a shell one
DEVICE='.devices[] | select(.id == $id)'

for i in $(seq 1 "$runs"); do
	echo "== run $i of $runs"
	[ "$(state "$DEVICE | .status")" = online ] || die "$device is not online, see the status page"
	# The checks of the wipe script: BootOrder, the iPXE entry, the partitions.
	test_system osreboot-wipe >/dev/null || die "osreboot-wipe refused, run it on the test system to see why"

	since=$(state .now)
	# The machine resets in the middle of the command, so ssh never ends cleanly.
	test_system osreboot-wipe --apply || true

	# Done when the device is online and its latest outage began at this wipe.
	waited=0
	until [ "$(state "$DEVICE | .status == \"online\" and (.history[0].start // 0) >= \$since - 10000" "$since" || echo false)" = true ]; do
		[ "$waited" -lt "$timeout" ] || die "run $i did not end within $timeout s, the series stops"
		sleep 5
		waited=$((waited + 5))
	done
	echo "   downtime $(state "$DEVICE | .history[0] | (.end - .start) / 100 | round / 10") s"

	[ "$i" = "$runs" ] || sleep "$pause"
done
echo "Sum up on the server: docker compose exec osreboot node dist/outage-stats.js data/outages.csv"
