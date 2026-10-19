#!/usr/bin/env bash
# Builds ipxe.efi, the network boot loader the machine starts from its main
# ESP: iPXE with HTTPS, osreboot.ipxe built in and the ISRG roots of Let's
# Encrypt as its only trusted certificates.
#
#   bash ipxe/build.sh HOST [WORKDIR]    e.g. bash ipxe/build.sh osreboot.example.org
#
# HOST serves the server's files at https://HOST/files/. The source is cloned
# into WORKDIR (default ipxe/build) and the result goes to ipxe/out/ipxe.efi.
# It is the full ipxe.efi with its own network drivers: snponly.efi finds no
# network card when it is started from a disk.
set -euo pipefail

# iPXE has no releases that are updated often; this commit is known to work.
IPXE_REPO=https://github.com/ipxe/ipxe.git
IPXE_COMMIT=a03f9eda42e6271bc9c4fab20602b0a764b443ce

here=$(cd "$(dirname "$0")" && pwd)
host=${1:?usage: build.sh HOST [WORKDIR]}
work=${2:-$here/build}
[[ $host =~ ^[A-Za-z0-9.-]+$ ]] || { echo "build.sh: bad host name: $host" >&2; exit 1; }

if [ ! -d "$work/.git" ]; then
	git init -q "$work"
	git -C "$work" remote add origin "$IPXE_REPO"
fi
if [ "$(git -C "$work" rev-parse -q --verify HEAD || true)" != "$IPXE_COMMIT" ]; then
	git -C "$work" fetch -q --depth 1 origin "$IPXE_COMMIT"
	git -C "$work" checkout -q --detach FETCH_HEAD
fi

# Build options beyond the defaults: HTTPS and the commands osreboot.ipxe uses.
cat >"$work/src/config/local/general.h" <<'EOF'
#define DOWNLOAD_PROTO_HTTPS
#define NSLOOKUP_CMD
#define PING_CMD
#define REBOOT_CMD
#define POWEROFF_CMD
EOF

mkdir -p "$here/out"
sed "s/@HOST@/$host/" "$here/osreboot.ipxe" >"$here/out/osreboot.ipxe"
certs=$here/isrg-root-x1.pem,$here/isrg-root-x2.pem
make -C "$work/src" -j"$(nproc)" bin-x86_64-efi/ipxe.efi \
	EMBED="$here/out/osreboot.ipxe" TRUST="$certs" CERT="$certs"
cp "$work/src/bin-x86_64-efi/ipxe.efi" "$here/out/ipxe.efi"
sha256sum "$here/out/ipxe.efi"
