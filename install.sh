#!/bin/sh
set -eu
umask 077

version="${YSK_VERSION:-0.2.1}"
case "$version" in ''|*[!0-9.]*|.*|*..*) echo "Invalid YSK_VERSION" >&2; exit 1 ;; esac
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Use install.ps1 on Windows." >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Supported architectures: x64 and arm64." >&2; exit 1 ;; esac
if [ "$os" = linux ] && [ -f /etc/alpine-release ]; then
  echo "The Linux release requires glibc. Alpine/musl is not supported by this installer." >&2
  exit 1
fi
root="${YSK_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/you-should-know}"
base="${YSK_RELEASE_BASE_URL:-https://github.com/polanski13/you-should-know/releases/download/v$version}"
asset="you-should-know-$os-$arch.tar.gz"
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required." >&2; exit 1; }
mkdir -p "$root/versions"
lock="$root/.install-lock"
mkdir "$lock" 2>/dev/null || { echo "Another installation is running. If it was interrupted, remove $lock and retry." >&2; exit 1; }
temporary=
trap 'if [ -n "$temporary" ]; then rm -rf "$temporary"; fi; rmdir "$lock"' 0
trap 'exit 130' HUP INT TERM
temporary=$(mktemp -d "$root/versions/.download.XXXXXX")
printf '\nInstalling You Should Know %s for %s/%s…\n' "$version" "$os" "$arch"
curl -fsSL --retry 3 --connect-timeout 20 "$base/$asset" -o "$temporary/$asset"
curl -fsSL --retry 3 --connect-timeout 20 "$base/SHA256SUMS" -o "$temporary/SHA256SUMS"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || { echo "Missing release checksum." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{print $1}')
else
  echo "sha256sum or shasum is required." >&2; exit 1
fi
[ "$actual" = "$expected" ] || { echo "Release checksum mismatch; installation stopped." >&2; exit 1; }
mkdir "$temporary/payload"
tar -xzf "$temporary/$asset" -C "$temporary/payload"
[ "$(cat "$temporary/payload/VERSION")" = "$version" ] || { echo "Release version mismatch." >&2; exit 1; }
"$temporary/payload/runtime/node" "$temporary/payload/app/cli.js" --version >/dev/null
printf '%s\n' "$expected" >"$temporary/payload/ARCHIVE_SHA256"
target="$root/versions/$version"
if [ -d "$target" ]; then
  [ "$(cat "$target/ARCHIVE_SHA256")" = "$expected" ] || { echo "The existing version differs from this release. Preserve it and choose a different YSK_INSTALL_DIR." >&2; exit 1; }
else
  mv "$temporary/payload" "$target"
fi
if [ -t 0 ] || [ "$#" -gt 0 ]; then
  "$target/runtime/node" "$target/app/cli.js" setup --install-root "$root" "$@"
elif [ -c /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
  "$target/runtime/node" "$target/app/cli.js" setup --install-root "$root" </dev/tty
else
  "$target/runtime/node" "$target/app/cli.js" setup --install-root "$root"
fi
