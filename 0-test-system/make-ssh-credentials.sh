#!/usr/bin/env bash
# Makes the test system's SSH keys (tunnel key and host key) and encrypts them
# with this machine's TPM, so that the public image can carry them.
#   sudo bash make-ssh-credentials.sh DIR    writes DIR/NAME.cred and DIR/NAME.pub
set -euo pipefail

NAMES="osreboot-tunnel-key osreboot-ssh-host-key"

die() {
	echo "make-ssh-credentials: $*" >&2
	exit 1
}

dir=${1:-}
[ -n "$dir" ] || die "usage: make-ssh-credentials.sh DIR"
[ "$(id -u)" = 0 ] || die "run it with sudo"
for c in ssh-keygen systemd-creds cmp; do
	command -v "$c" >/dev/null || die "$c is not installed"
done
[ -e /dev/tpmrm0 ] || die "no TPM at /dev/tpmrm0"
for f in /etc/systemd/tpm2-pcr-public-key.pem /run/systemd/tpm2-pcr-public-key.pem /usr/lib/systemd/tpm2-pcr-public-key.pem; do
	[ ! -e "$f" ] || die "$f exists; systemd-creds would bind the keys to a signed PCR policy"
done
for name in $NAMES; do
	if [ -e "$dir/$name.cred" ] || [ -e "$dir/$name.pub" ]; then
		die "$dir/$name.cred or .pub exists already"
	fi
done

# The plain private keys stay in memory (/run) and are deleted on exit.
work=$(mktemp -d -p /run)
trap 'rm -rf "$work"' EXIT

host=$(uname -n)
for name in $NAMES; do
	ssh-keygen -q -t ed25519 -N '' -C "$name@$host" -f "$work/$name"
	# Bound to this TPM only, not to firmware settings (no PCRs), like the token.
	systemd-creds encrypt --with-key=tpm2 --name="$name" "$work/$name" "$work/$name.cred"
	systemd-creds decrypt --name="$name" "$work/$name.cred" - | cmp -s - "$work/$name" ||
		die "$name does not decrypt back"
done

if [ ! -d "$dir" ]; then
	mkdir -p "$dir"
	chown "${SUDO_USER:-root}:" "$dir"
fi
for name in $NAMES; do
	install -m 0600 "$work/$name.cred" "$dir/$name.cred"
	install -m 0644 "$work/$name.pub" "$dir/$name.pub"
	chown "${SUDO_USER:-root}:" "$dir/$name.cred" "$dir/$name.pub"
	ssh-keygen -lf "$dir/$name.pub"
done
echo "Done: $dir holds the encrypted keys (.cred) and the public keys (.pub)."
