#!/usr/bin/env bash
set -euo pipefail

export LD_LIBRARY_PATH="/opt/chromium-compat${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Chromium is copied from Debian to avoid Ubuntu's Snap-only package. Keep its
# media compatibility libraries, but use Ubuntu's matching NSS family as one
# unit; mixing Debian libnssutil with Ubuntu libsoftokn aborts during startup.
case "$(uname -m)" in
  x86_64) system_libdir="/lib/x86_64-linux-gnu" ;;
  aarch64 | arm64) system_libdir="/lib/aarch64-linux-gnu" ;;
  *) system_libdir="" ;;
esac
if [[ -n "$system_libdir" ]]; then
  nss_preload="$system_libdir/libnssutil3.so:$system_libdir/libnss3.so:$system_libdir/libsmime3.so:$system_libdir/libnspr4.so"
  export LD_PRELOAD="$nss_preload${LD_PRELOAD:+:$LD_PRELOAD}"
fi

exec /usr/lib/chromium/chromium "$@"
