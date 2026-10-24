#!/usr/bin/env bash
# Writes the test system from DIR (two .raw.zst images, SHA256SUMS, optionally
# osreboot.token) into osreboot-esp and osreboot-root, from the main system, and
# adds a firmware boot entry without changing the boot order.
#   sudo bash write-test-system.sh DIR           checks and plan, changes nothing
#   sudo bash write-test-system.sh DIR --apply   writes; asks for confirmation
set -euo pipefail

ESP_LABEL=osreboot-esp
ROOT_LABEL=osreboot-root
ESP_IMAGE=osreboot-test.esp.raw
ROOT_IMAGE=osreboot-test.root-x86-64.raw
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
ENTRY_LABEL="OSreboot test"
LOADER='\EFI\systemd\systemd-bootx64.efi'

die() {
	echo "write-test-system: $*" >&2
	exit 1
}

dir=${1:-}
[ -n "$dir" ] && [ -d "$dir" ] || die "usage: write-test-system.sh DIR [--apply]"
dir=$(cd "$dir" && pwd)
apply=no
[ "${2:-}" = --apply ] && apply=yes
[ "$(id -u)" = 0 ] || die "run it with sudo"
for c in zstd sha256sum dd blockdev e2fsck resize2fs efibootmgr systemd-creds findmnt lsblk mount; do
	command -v "$c" >/dev/null || die "$c is not installed"
done

# The only partition with this label, as /dev/... path.
partition() {
	local label=$1 found
	found=$(lsblk -rno PATH,PARTLABEL | awk -v l="$label" '$2 == l { print $1 }')
	[ -n "$found" ] || die "no partition is labelled $label"
	[ "$(wc -l <<<"$found")" = 1 ] || die "more than one partition is labelled $label: $found"
	echo "$found"
}

# A partition this script may overwrite: not mounted, not swap, and no other
# block device (such as an open LUKS volume) built on it.
unused() {
	local dev=$1 name
	name=$(basename "$dev")
	[ -z "$(findmnt -rno TARGET -S "$dev")" ] || die "$dev is mounted"
	! grep -q "^$dev " /proc/swaps || die "$dev is used as swap"
	[ -z "$(ls "/sys/class/block/$name/holders")" ] || die "$dev is used by $(ls "/sys/class/block/$name/holders")"
}

# The number of the boot entry titled $ENTRY_LABEL: 0006 for "Boot0006* OSreboot test".
entry_number() {
	efibootmgr | awk -v l="$ENTRY_LABEL" '{ line = $0; sub(/^Boot[0-9A-Fa-f]{4}\*? /, "", line) }
		/^Boot[0-9A-Fa-f]{4}/ && index(line, l) == 1 { print substr($1, 5, 4) }'
}

echo "== Checks"
esp=$(partition $ESP_LABEL)
root=$(partition $ROOT_LABEL)
disk=/dev/$(lsblk -no PKNAME "$esp")
[ "$disk" = "/dev/$(lsblk -no PKNAME "$root")" ] || die "$esp and $root are on different disks"
[ "$(lsblk -no PARTTYPE "$esp")" = $ESP_TYPE ] || die "$esp is not an EFI system partition"
unused "$esp"
unused "$root"
# The partition number from sysfs: 3 for /dev/nvme0n1p3.
espnum=$(cat "/sys/class/block/$(basename "$esp")/partition")
esp_uuid=$(lsblk -no PARTUUID "$esp")

[ -f "$dir/SHA256SUMS" ] || die "$dir/SHA256SUMS is missing"
declare -A size checksum
for image in $ESP_IMAGE $ROOT_IMAGE; do
	[ -f "$dir/$image.zst" ] || die "$dir/$image.zst is missing"
	expected=$(awk -v f="$image" '$2 == f || $2 == "*" f { print $1 }' "$dir/SHA256SUMS")
	[ -n "$expected" ] || die "SHA256SUMS has no line for $image"
	actual=$(zstd -dcq "$dir/$image.zst" | sha256sum | cut -d' ' -f1)
	[ "$actual" = "$expected" ] || die "$image.zst does not match SHA256SUMS"
	size[$image]=$(zstd -dcq "$dir/$image.zst" | wc -c)
	checksum[$image]=$actual
done
[ "${size[$ESP_IMAGE]}" -le "$(blockdev --getsize64 "$esp")" ] || die "the ESP image does not fit into $esp"
[ "${size[$ROOT_IMAGE]}" -le "$(blockdev --getsize64 "$root")" ] || die "the root image does not fit into $root"

token=no
if [ -f "$dir/osreboot.token" ]; then
	token=yes
	[ -e /dev/tpmrm0 ] || die "no TPM at /dev/tpmrm0"
	for f in /etc/systemd/tpm2-pcr-public-key.pem /run/systemd/tpm2-pcr-public-key.pem /usr/lib/systemd/tpm2-pcr-public-key.pem; do
		[ ! -e "$f" ] || die "$f exists; systemd-creds would bind the token to a signed PCR policy"
	done
fi

existing=$(entry_number)
if [ -n "$existing" ]; then
	efibootmgr -v | grep "^Boot$existing" | grep -qi "$esp_uuid" ||
		die "boot entry $existing \"$ENTRY_LABEL\" points somewhere else; remove it first"
fi
echo "all checks passed"

echo
echo "== Plan"
echo "  $ESP_IMAGE ($((size[$ESP_IMAGE] / 1048576)) MiB) -> $esp ($(lsblk -no SIZE "$esp" | tr -d ' '))"
echo "  $ROOT_IMAGE ($((size[$ROOT_IMAGE] / 1048576)) MiB) -> $root ($(lsblk -no SIZE "$root" | tr -d ' ')), then grow the file system"
if [ $token = yes ]; then
	echo "  token: encrypt with this TPM into /etc/credstore.encrypted/osreboot-token, delete the plain copy"
else
	echo "  token: none in $dir, the heartbeat will not start until one is added"
fi
if [ -n "$existing" ]; then
	echo "  boot entry: Boot$existing \"$ENTRY_LABEL\" already exists, kept"
else
	echo "  boot entry: new \"$ENTRY_LABEL\" -> partition $espnum $LOADER; the boot order stays as it is"
fi
if [ $apply != yes ]; then
	echo
	echo "Nothing was changed. Run again with --apply to write."
	exit 0
fi

echo
read -r -p "Type write to overwrite $esp and $root: " answer
[ "$answer" = write ] || die "stopped, nothing was changed"

trap 'echo; echo "!! Stopped. The main system is not affected; run the script again."' ERR

write() {
	local image=$1 dev=$2
	echo "== Writing $image to $dev"
	zstd -dcq "$dir/$image.zst" | dd of="$dev" bs=4M iflag=fullblock conv=fsync status=progress
	blockdev --flushbufs "$dev"
	[ "$(head -c "${size[$image]}" "$dev" | sha256sum | cut -d' ' -f1)" = "${checksum[$image]}" ] ||
		{ echo "read-back of $dev does not match $image"; false; }
	echo "read back and verified"
}
write $ESP_IMAGE "$esp"
write $ROOT_IMAGE "$root"

echo "== Growing the root file system"
rc=0
e2fsck -f -y "$root" || rc=$?
[ "$rc" -le 1 ] || { echo "e2fsck failed with code $rc"; false; }
resize2fs "$root"

if [ $token = yes ]; then
	echo "== Encrypting the token with the TPM"
	systemd-creds encrypt --with-key=tpm2 --name=osreboot-token "$dir/osreboot.token" "$dir/osreboot-token.cred"
	systemd-creds decrypt --name=osreboot-token "$dir/osreboot-token.cred" - | cmp -s - "$dir/osreboot.token" ||
		{ echo "the encrypted token does not decrypt back"; false; }
	mnt=$(mktemp -d)
	mount "$root" "$mnt"
	install -d -m 0700 "$mnt/etc/credstore.encrypted"
	install -m 0400 "$dir/osreboot-token.cred" "$mnt/etc/credstore.encrypted/osreboot-token"
	umount "$mnt"
	rmdir "$mnt"
	rm -f "$dir/osreboot.token"
	chown "${SUDO_USER:-root}:" "$dir/osreboot-token.cred"
	echo "installed; the plain token is deleted, $dir/osreboot-token.cred is the encrypted copy"
fi

if [ -z "$existing" ]; then
	echo "== Adding the boot entry"
	order=$(efibootmgr | sed -n 's/^BootOrder: //p')
	efibootmgr --create-only --disk "$disk" --part "$espnum" --label "$ENTRY_LABEL" --loader "$LOADER" >/dev/null
	[ "$(efibootmgr | sed -n 's/^BootOrder: //p')" = "$order" ] || { echo "the boot order changed"; false; }
	existing=$(entry_number)
fi
trap - ERR

echo
echo "Done. The test system is boot entry Boot$existing; the boot order is unchanged."
echo "To boot it once, at the laptop: sudo efibootmgr --bootnext $existing && sudo systemctl reboot"
echo "Any later reboot goes back to the main system and its LUKS prompt."
