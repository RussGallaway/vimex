#!/bin/sh
set -eu
# Native Vimex bootstrap. No Bun, jq, or configuration changes required.
LC_ALL=C
export LC_ALL
repository='RussGallaway/vimex'
fail() { printf 'vimex install: %s\n' "$*" >&2; exit 1; }
version=${VIMEX_VERSION:-}
if [ "$#" -gt 1 ]; then fail 'Usage: install.sh [VERSION]'; fi
if [ "$#" -eq 1 ]; then version=$1; fi
root=${VIMEX_INSTALL_ROOT:-"$HOME/.local/share/vimex"}
bin=${VIMEX_BIN_DIR:-"$HOME/.local/bin"}
case "$root:$bin" in /*:/*) ;; *) fail 'Install root and bin directory must be absolute paths';; esac
for command in curl tar awk sed mktemp; do command -v "$command" >/dev/null 2>&1 || fail "Missing dependency: $command"; done
case "$(uname -s)" in Darwin) platform=darwin;; Linux) platform=linux;; *) fail 'Supported platforms: macOS and Linux';; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) fail 'Supported architectures: arm64 and x64';; esac
if [ -z "$version" ]; then
  version=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 "https://api.github.com/repos/$repository/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
version=${version#v}
printf '%s\n' "$version" | awk '/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/ {ok=1} END {exit !ok}' || fail 'Invalid release version'
receipt="$root/.vimex-install.json"
if [ -L "$root/versions" ]; then fail 'Managed versions directory must not be a symlink'; fi
if [ -e "$root/versions" ] && [ ! -d "$root/versions" ]; then fail 'Managed versions path is not a directory'; fi
if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  [ -L "$root/current" ] || fail "Existing current installation is not a symlink"
  current_target=$(readlink "$root/current")
  printf '%s\n' "$current_target" | awk '/^versions\/[A-Za-z0-9][A-Za-z0-9._-]*$/ {ok=1} END {exit !ok}' || fail 'Current symlink does not point to a managed version'
  [ -d "$root/$current_target" ] && [ ! -L "$root/$current_target" ] || fail 'Current version must be a real managed directory' 
fi
if [ -e "$bin/vimex" ] || [ -L "$bin/vimex" ]; then
  [ -L "$bin/vimex" ] && [ "$(readlink "$bin/vimex")" = "$root/current/vimex" ] || fail "Refusing to replace an unrelated executable at $bin/vimex (use its package manager)"
fi
if [ -e "$root" ]; then
  [ -d "$root" ] && [ ! -L "$root" ] || fail 'Install root must be a real directory'
  if [ -n "$(ls -A "$root")" ]; then
    [ -f "$receipt" ] || fail 'Existing nonempty install root has no Vimex receipt'
    [ ! -L "$receipt" ] || fail 'Receipt must not be a symlink'
    tr -d '[:space:]' < "$receipt" | awk '
      /^\{.*\}$/ {
        sub(/^\{/, ""); sub(/\}$/, ""); n=split($0, fields, ",")
        for (i=1;i<=n;i++) {
          if (fields[i] == "\"schemaVersion\":1") schema++
          else if (fields[i] == "\"kind\":\"direct\"") kind++
          else if (fields[i] ~ /^"version":"[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?"$/) version++
        }
      } END {exit !(n==3 && schema==1 && kind==1 && version==1)}' || fail 'Invalid direct-install receipt; use the owning package manager' 
  fi
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/vimex-install.XXXXXX")
stage=''
locked=''
root_created=''
cleanup() {
  rm -rf "$work"
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
  if [ -n "$locked" ]; then rmdir "$root/.upgrade-lock" 2>/dev/null || true; fi
  if [ -n "$root_created" ]; then rmdir "$root/versions" 2>/dev/null || true; rmdir "$root" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
artifact="vimex-v$version-$platform-$arch.tar.gz"
base="https://github.com/$repository/releases/download/v$version"
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 "$1" -o "$2"; }
fetch "$base/$artifact" "$work/archive.tar.gz"
fetch "$base/SHA256SUMS" "$work/SHA256SUMS"
expected=$(awk -v name="$artifact" '$2 == name || $2 == "*" name {print $1}' "$work/SHA256SUMS")
[ "${#expected}" -eq 64 ] || fail 'Missing or ambiguous release checksum'
case "$expected" in *[!0-9a-fA-F]*) fail 'Invalid checksum';; esac
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/archive.tar.gz" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$work/archive.tar.gz" | awk '{print $1}')
else fail 'Missing SHA-256 tool (sha256sum or shasum)'; fi
[ "$actual" = "$expected" ] || fail 'Checksum mismatch; existing installation was not changed'
tar -tzf "$work/archive.tar.gz" > "$work/members"
# Reject absolute/traversal paths and ambiguous escaped names before extraction.
awk 'BEGIN {ok=1} /^\// || /(^|\/)\.\.(\/|$)/ || /\\/ {ok=0} !/^(\.\/)?(vimex|LICENSE|assets|share)(\/|$)/ && $0 != "./" {ok=0} END {exit !ok}' "$work/members" || fail 'Unsafe archive path'
tar -tvzf "$work/archive.tar.gz" > "$work/types"
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {bad=1} END {exit bad}' "$work/types" || fail 'Archive links and special files are not allowed'
if [ ! -d "$root" ]; then mkdir -p "$root"; root_created=1; fi
mkdir "$root/.upgrade-lock" 2>/dev/null || fail 'Another upgrade is running, or a previous upgrade left .upgrade-lock; inspect it before retrying'
locked=1
# Recheck containment after taking the same lock used by the native updater.
[ ! -L "$root/versions" ] || fail 'Managed versions directory must not be a symlink'
mkdir -p "$root/versions" "$bin"
stage=$(mktemp -d "$root/.stage.XXXXXX")
# Strip ownership and preserve local umask. Archive types and paths were validated above.
tar -xzf "$work/archive.tar.gz" -C "$stage" --no-same-owner --no-same-permissions
[ -f "$stage/vimex" ] && [ -f "$stage/share/man/man1/vimex.1" ] && [ -d "$stage/assets" ] || fail 'Incomplete release archive'
chmod 755 "$stage/vimex"
# Unique destinations avoid modifying a running or rollback version.
bundle="vimex-v$version-$platform-$arch-$(basename "$stage")"
mv "$stage" "$root/versions/$bundle"
stage=''
ln -s "versions/$bundle" "$work/current"
# Stage the symlink in the same filesystem before an atomic replacement.
mv "$work/current" "$root/.current-next-$$"
if [ "$platform" = darwin ]; then mv -fh "$root/.current-next-$$" "$root/current"
else mv -fT "$root/.current-next-$$" "$root/current"; fi
printf '{"schemaVersion":1,"kind":"direct","version":"%s"}\n' "$version" > "$root/.receipt-next-$$"
mv -f "$root/.receipt-next-$$" "$receipt"
if [ ! -L "$bin/vimex" ]; then ln -s "$root/current/vimex" "$bin/vimex"; fi
printf 'Installed vimex %s to %s\n' "$version" "$bin/vimex"
printf 'Ensure %s is on PATH. Run: vimex --version\n' "$bin"
