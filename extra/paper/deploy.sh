#!/usr/bin/env bash
# Builds the paper site (npm run paper) and uploads it to the VPS. The previous
# version stays beside it in prev/, nginx config: nginx.conf.
#   extra/paper/deploy.sh [user@host]
set -euo pipefail

target=${1:-root@epsti.site}
dir=/var/www/paper.epsti.site
here=$(cd "$(dirname "$0")" && pwd)

cd "$here/../.."
npm run --silent paper
# --no-same-owner: files belong to root on the VPS, not to the local uid.
# shellcheck disable=SC2029 # $dir expands here on purpose
tar -C "$here/dist" -cf - . | ssh "$target" "set -e
	rm -rf $dir/new && mkdir -p $dir/new
	tar -C $dir/new --no-same-owner -xf -
	cd $dir && rm -rf prev
	if [ -e html ]; then mv html prev; fi
	mv new html"
echo "deploy-paper: uploaded to $target:$dir/html"
