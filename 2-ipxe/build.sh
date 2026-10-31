#!/usr/bin/env bash
# Builds 2-ipxe/out/ipxe.efi: iPXE with HTTPS, osreboot.ipxe built in and the
# Let's Encrypt (ISRG) roots as the only trusted certificates.
#   bash 2-ipxe/build.sh HOST    HOST serves the files, e.g. osreboot.example.org
set -euo pipefail

IPXE_COMMIT=a03f9eda42e6271bc9c4fab20602b0a764b443ce

host=${1:-}
if [ -z "$host" ]; then
	echo "usage: bash 2-ipxe/build.sh HOST"
	exit 1
fi
here=$(cd "$(dirname "$0")" && pwd)
work=$here/build

if [ ! -d "$work" ]; then
	git clone https://github.com/ipxe/ipxe.git "$work"
fi

git -C "$work" checkout -q "$IPXE_COMMIT"
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
