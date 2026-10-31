#!/usr/bin/env bash
# Writes the test system from DIR (two .raw.zst images, SHA256SUMS and maybe
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
MIB=$((1024 * 1024))

die() {
	echo "write-test-system: $*" >&2
	exit 1
}

partition() {
	local found
	found=$(lsblk -rno PATH,PARTLABEL | awk -v label="$1" '$2 == label { print $1 }')
	[ "$(echo "$found" | wc -w)" = 1 ] || die "need exactly one partition labelled $1"
	echo "$found"
}

# Not mounted, not swap, and nothing (such as an open LUKS volume) built on it.
check_unused() {
	local dev=$1 holders
	[ -z "$(findmnt -rno TARGET -S "$dev")" ] || die "$dev is mounted"
	if grep -q "^$dev " /proc/swaps; then
		die "$dev is used as swap"
	fi
	holders=$(ls "/sys/class/block/$(basename "$dev")/holders")
	[ -z "$holders" ] || die "$dev is used by $holders"
}

# "Boot0006* OSreboot test" -> 0006
entry_number() {
	efibootmgr | grep "^Boot....\* $ENTRY_LABEL" | cut -c5-8 || true
}

# A line of SHA256SUMS is "SUM  NAME" or "SUM *NAME".
expected_sum() {
	awk -v name="$1" '$2 == name || $2 == "*" name { print $1 }' "$dir/SHA256SUMS"
}

unpacked_sum() {
	zstd -dcq "$dir/$1.zst" | sha256sum | cut -d' ' -f1
}

write_image() {
	local image=$1 dev=$2 size=$3 checksum=$4
	echo "== Writing $image to $dev"
	zstd -dcq "$dir/$image.zst" | dd of="$dev" bs=4M iflag=fullblock conv=fsync status=progress
	blockdev --flushbufs "$dev"
	[ "$(head -c "$size" "$dev" | sha256sum | cut -d' ' -f1)" = "$checksum" ] ||
		die "the read-back of $dev does not match $image"
	echo "read back and verified"
}

dir=${1:-}
[ -d "$dir" ] || die "usage: write-test-system.sh DIR [--apply]"
dir=$(cd "$dir" && pwd)
[ "$(id -u)" = 0 ] || die "run it with sudo"
for c in zstd sha256sum dd blockdev e2fsck resize2fs efibootmgr systemd-creds findmnt lsblk mount; do
	command -v "$c" >/dev/null || die "$c is not installed"
done

echo "== Checks"
esp=$(partition $ESP_LABEL)
root=$(partition $ROOT_LABEL)
disk=/dev/$(lsblk -no PKNAME "$esp")
[ "$disk" = "/dev/$(lsblk -no PKNAME "$root")" ] || die "$esp and $root are on different disks"
[ "$(lsblk -no PARTTYPE "$esp")" = $ESP_TYPE ] || die "$esp is not an EFI system partition"
check_unused "$esp"
check_unused "$root"
# The partition number: /sys/class/block/nvme0n1p3/partition holds 3.
espnum=$(cat "/sys/class/block/$(basename "$esp")/partition")
esp_uuid=$(lsblk -no PARTUUID "$esp")

[ -f "$dir/SHA256SUMS" ] || die "$dir/SHA256SUMS is missing"
[ -f "$dir/$ESP_IMAGE.zst" ] || die "$dir/$ESP_IMAGE.zst is missing"
[ -f "$dir/$ROOT_IMAGE.zst" ] || die "$dir/$ROOT_IMAGE.zst is missing"
esp_sum=$(expected_sum $ESP_IMAGE)
root_sum=$(expected_sum $ROOT_IMAGE)
[ -n "$esp_sum" ] || die "SHA256SUMS has no line for $ESP_IMAGE"
[ -n "$root_sum" ] || die "SHA256SUMS has no line for $ROOT_IMAGE"
[ "$(unpacked_sum $ESP_IMAGE)" = "$esp_sum" ] || die "$ESP_IMAGE.zst does not match SHA256SUMS"
[ "$(unpacked_sum $ROOT_IMAGE)" = "$root_sum" ] || die "$ROOT_IMAGE.zst does not match SHA256SUMS"
esp_size=$(zstd -dcq "$dir/$ESP_IMAGE.zst" | wc -c)
root_size=$(zstd -dcq "$dir/$ROOT_IMAGE.zst" | wc -c)
[ "$esp_size" -le "$(blockdev --getsize64 "$esp")" ] || die "the ESP image does not fit into $esp"
[ "$root_size" -le "$(blockdev --getsize64 "$root")" ] || die "the root image does not fit into $root"

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
echo "  $ESP_IMAGE ($((esp_size / MIB)) MiB) -> $esp ($(lsblk -no SIZE "$esp" | tr -d ' '))"
echo "  $ROOT_IMAGE ($((root_size / MIB)) MiB) -> $root ($(lsblk -no SIZE "$root" | tr -d ' ')), then grow the file system"
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
if [ "${2:-}" != --apply ]; then
	echo
	echo "Nothing was changed. Run again with --apply to write."
	exit 0
fi

echo
read -r -p "Type write to overwrite $esp and $root: " answer
[ "$answer" = write ] || die "stopped, nothing was changed"

write_image $ESP_IMAGE "$esp" "$esp_size" "$esp_sum"
write_image $ROOT_IMAGE "$root" "$root_size" "$root_sum"

echo "== Growing the root file system"
# e2fsck exits with 1 when it has fixed something: 0 and 1 are fine.
rc=0
e2fsck -f -y "$root" || rc=$?
[ "$rc" -le 1 ] || die "e2fsck failed with code $rc"
resize2fs "$root"

if [ $token = yes ]; then
	echo "== Encrypting the token with the TPM"
	systemd-creds encrypt --with-key=tpm2 --name=osreboot-token "$dir/osreboot.token" "$dir/osreboot-token.cred"
	systemd-creds decrypt --name=osreboot-token "$dir/osreboot-token.cred" - | cmp -s - "$dir/osreboot.token" ||
		die "the encrypted token does not decrypt back"
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
	order=$(efibootmgr | awk '$1 == "BootOrder:" { print $2 }')
	efibootmgr --create-only --disk "$disk" --part "$espnum" --label "$ENTRY_LABEL" --loader "$LOADER" >/dev/null
	[ "$(efibootmgr | awk '$1 == "BootOrder:" { print $2 }')" = "$order" ] || die "the boot order changed"
	existing=$(entry_number)
fi

echo
echo "Done. The test system is boot entry Boot$existing; the boot order is unchanged."
echo "To boot it once, at the laptop: sudo efibootmgr --bootnext $existing && sudo systemctl reboot"
echo "Any later reboot goes back to the main system and its LUKS prompt."
