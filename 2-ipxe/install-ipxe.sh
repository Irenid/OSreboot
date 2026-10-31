#!/usr/bin/env bash
# Installs ipxe.efi as /EFI/osreboot/ipxe.efi on the main ESP with the
# systemd-boot entry osreboot-ipxe.conf; osreboot-wipe later makes it the default.
#   sudo bash install-ipxe.sh IPXE_EFI           checks and plan, changes nothing
#   sudo bash install-ipxe.sh IPXE_EFI --apply   installs
set -euo pipefail

ENTRY=osreboot-ipxe.conf
LOADER=/EFI/osreboot/ipxe.efi
TITLE="OSreboot network recovery (iPXE)"
LOADER_INFO=/sys/firmware/efi/efivars/LoaderInfo-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f

die() {
	echo "install-ipxe: $*" >&2
	exit 1
}

entries() {
	bootctl list --no-pager | awk '$1 == "id:" { print $2 }'
}

# `bootctl list` marks the title of the default entry with "(default)".
default_entry() {
	bootctl list --no-pager | awk '
		$1 == "title:" { is_default = / \(default\)/ }
		$1 == "id:" && is_default { print $2; exit }'
}

efi=${1:-}
[ -f "$efi" ] || die "usage: install-ipxe.sh IPXE_EFI [--apply]"
[ "$(id -u)" = 0 ] || die "run it with sudo"
for c in bootctl efibootmgr findmnt lsblk sha256sum; do
	command -v "$c" >/dev/null || die "$c is not installed"
done

echo "== Checks"
# Every EFI program starts with the bytes MZ.
[ "$(head -c 2 "$efi")" = MZ ] || die "$efi is not an EFI program"
[ -e "$LOADER_INFO" ] || die "this system was not started by systemd-boot"
esp=$(bootctl --print-esp-path)
esp_dev=$(findmnt -no SOURCE "$esp")
esp_uuid=$(lsblk -no PARTUUID "$esp_dev")
# The firmware starts the first entry of BootOrder: it must be systemd-boot on this ESP.
first=$(efibootmgr | awk '$1 == "BootOrder:" { print substr($2, 1, 4) }')
[ -n "$first" ] || die "the firmware has no BootOrder"
efibootmgr -v | grep "^Boot$first" | grep -qi "$esp_uuid" ||
	die "Boot$first, the first entry of BootOrder, does not start from $esp ($esp_dev)"
before=$(default_entry)
[ -n "$before" ] || die "systemd-boot reports no default entry"
[ "$before" != $ENTRY ] || die "$ENTRY is the default entry: fix loader.conf first"
echo "all checks passed"

echo
echo "== Plan"
echo "  $efi -> $esp$LOADER (sha256 $(sha256sum <"$efi" | cut -c1-16)...)"
echo "  boot entry $esp/loader/entries/$ENTRY \"$TITLE\""
echo "  BootOrder starts with Boot$first on $esp_dev; the default entry stays $before"
if [ "${2:-}" != --apply ]; then
	echo
	echo "Nothing was changed. Run again with --apply to install."
	exit 0
fi

echo
echo "== Installing"
install -d "$esp/EFI/osreboot" "$esp/loader/entries"
if [ -f "$esp$LOADER" ]; then
	cp "$esp$LOADER" "$esp$LOADER.prev"
fi
# Copy, then rename: a power cut leaves the old or the new file, never half of one.
cp "$efi" "$esp$LOADER.new"
mv "$esp$LOADER.new" "$esp$LOADER"
printf 'title %s\nefi %s\n' "$TITLE" "$LOADER" >"$esp/loader/entries/$ENTRY.new"
mv "$esp/loader/entries/$ENTRY.new" "$esp/loader/entries/$ENTRY"
sync -f "$esp/loader/entries/$ENTRY"

echo "== Verifying"
[ "$(sha256sum <"$esp$LOADER")" = "$(sha256sum <"$efi")" ] || die "$esp$LOADER differs from $efi"
entries | grep -qx $ENTRY || die "systemd-boot does not list $ENTRY"
after=$(default_entry)
if [ "$after" != "$before" ]; then
	rm "$esp/loader/entries/$ENTRY"
	die "with $ENTRY the default entry would be $after, not $before: removed $ENTRY again"
fi
echo "installed; the default entry is still $after"
echo
echo "To start the recovery once: sudo systemctl reboot --boot-loader-entry=$ENTRY"
