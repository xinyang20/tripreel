#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in
    */tripreel.xinyang20.cn)
        /usr/sbin/nginx -t
        /usr/bin/systemctl reload nginx
        ;;
esac
