#!/usr/bin/env bash
# Repeats the demo RUNS times: osreboot-wipe --apply through the SSH tunnel, then
# waits for the restored system's heartbeat. Stops at the first failed run.
#   OSREBOOT_URL=https://osreboot.example.org OSREBOOT_SSH=root@osreboot.example.org \
#     scripts/run-series.sh RUNS
# Optional: OSREBOOT_SSH_PORT=2221 OSREBOOT_DEVICE=laptop PAUSE_S=60 TIMEOUT_S=900,
# SAVE_DIR=results/series-<UTC time> for copies of /api/state. Needs ssh, curl, jq.
set -euo pipefail

runs=${1:?usage: run-series.sh RUNS}
: "${OSREBOOT_URL:?set OSREBOOT_URL}"
: "${OSREBOOT_SSH:?set OSREBOOT_SSH}"
port=${OSREBOOT_SSH_PORT:-2221}
device=${OSREBOOT_DEVICE:-laptop}
pause=${PAUSE_S:-60}
timeout=${TIMEOUT_S:-900}
root=$(cd "$(dirname "$0")/.." && pwd)
save=${SAVE_DIR:-$root/results/series-$(date -u +%Y%m%dT%H%M)}
mkdir -p "$save"

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

# The device is online again, and its latest outage began at this wipe ($since, ± 10 s).
back_online() {
	[ "$(state "$DEVICE | .status == \"online\" and (.history[0].start // 0) >= \$since - 10000" "$since" || echo false)" = true ]
}

for i in $(seq 1 "$runs"); do
	echo "== run $i of $runs"
	[ "$(state "$DEVICE | .status")" = online ] || die "$device is not online, see the status page"
	# The checks of the wipe script: BootOrder, the iPXE entry, the partitions.
	test_system osreboot-wipe >/dev/null || die "osreboot-wipe refused, run it on the test system to see why"
	# The downloads can't be faster than the wired link: 100 Mb/s is about 11 MiB/s.
	echo "   link $(test_system 'cat /sys/class/net/en*/speed 2>/dev/null | sort -rn | head -n 1' || echo '?') Mb/s"

	since=$(state .now)
	# The machine resets in the middle of the command, so ssh never ends cleanly.
	test_system osreboot-wipe --apply || true

	waited=0
	until back_online; do
		[ "$waited" -lt "$timeout" ] || die "run $i did not end within $timeout s, the series stops"
		sleep 5
		waited=$((waited + 5))
	done
	# The latest outage in seconds, with one decimal.
	echo "   downtime $(state "$DEVICE | .history[0] | (.end - .start) / 100 | round / 10") s"
	curl -fsS --max-time 10 "${OSREBOOT_URL%/}/api/state" >"$save/state-$i.json" ||
		echo "   could not save the state, the transfers of run $i are lost" >&2

	[ "$i" = "$runs" ] || sleep "$pause"
done
echo "States are in $save. Sum up: node dist/outage-stats.js with the server's outages.csv, see README.md"
