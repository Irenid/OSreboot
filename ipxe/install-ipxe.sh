#!/usr/bin/env bash
# Installs ipxe.efi as /EFI/osreboot/ipxe.efi on the main ESP with the
# systemd-boot entry osreboot-ipxe.conf, which only ever boots once (one-shot).
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

efi=${1:-}
[ -n "$efi" ] && [ -f "$efi" ] || die "usage: install-ipxe.sh IPXE_EFI [--apply]"
apply=no
[ "${2:-}" = --apply ] && apply=yes
[ "$(id -u)" = 0 ] || die "run it with sudo"
for c in bootctl efibootmgr findmnt lsblk sha256sum; do
	command -v "$c" >/dev/null || die "$c is not installed"
done

# The ids of the boot entries, and the id of the default one: `bootctl list`
# marks its title with "(default)" and prints its id a line later.
entries() {
	bootctl list --no-pager | awk '$1 == "id:" { print $2 }'
}
default_entry() {
	bootctl list --no-pager | awk '$1 == "title:" { d = / \(default\)/ } $1 == "id:" && d { print $2; exit }'
}

echo "== Checks"
[ "$(head -c 2 "$efi")" = MZ ] || die "$efi is not an EFI program"
[ -e "$LOADER_INFO" ] || die "this system was not started by systemd-boot"
esp=$(bootctl --print-esp-path)
esp_dev=$(findmnt -no SOURCE "$esp")
esp_uuid=$(lsblk -no PARTUUID "$esp_dev")
# The firmware boots the first entry of BootOrder ("BootOrder: 0001,0000" -> 0001);
# only systemd-boot on this ESP sees the one-shot entry.
first=$(efibootmgr | sed -n 's/^BootOrder: \([0-9A-Fa-f]\{4\}\).*/\1/p')
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
if [ $apply != yes ]; then
	echo
	echo "Nothing was changed. Run again with --apply to install."
	exit 0
fi

echo
echo "== Installing"
install -d "$esp/EFI/osreboot" "$esp/loader/entries"
[ ! -f "$esp$LOADER" ] || cp "$esp$LOADER" "$esp$LOADER.prev"
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
