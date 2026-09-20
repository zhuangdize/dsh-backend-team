#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="18.6"
SOURCE_URL="https://ftp.postgresql.org/pub/source/v${VERSION}/postgresql-${VERSION}.tar.bz2"
SOURCE_SHA256="555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f"
test "$(uname -s)" = Darwin || { echo "PostgreSQL runtime build requires native macOS" >&2; exit 1; }
MACHINE="$(uname -m)"
case "$MACHINE" in arm64) ARCH="arm64" ;; x86_64) ARCH="x64" ;; *) echo "unsupported native macOS architecture: $MACHINE" >&2; exit 1 ;; esac
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/dsh-postgresql.XXXXXX")" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
PREFIX="$WORK/postgresql-${VERSION}-${ARCH}"
ARCHIVE="$WORK/postgresql-${VERSION}.tar.bz2"
curl --fail --location --proto '=https' --tlsv1.2 "$SOURCE_URL" --output "$ARCHIVE"
echo "$SOURCE_SHA256  $ARCHIVE" | shasum -a 256 -c -
tar -xjf "$ARCHIVE" -C "$WORK"
cd "$WORK/postgresql-${VERSION}"
export MACOSX_DEPLOYMENT_TARGET=13.0
# PostgreSQL 18 removed the --without-ssl spelling. Omit the option and let
# configure apply the platform default; an explicit SSL library can be added
# only when its workspace-local dependency closure is attested.
./configure --prefix="$PREFIX" --without-readline --without-zlib --without-icu --without-lz4 --without-zstd --without-libxml --without-libxslt --without-ldap --without-pam --without-bonjour --without-gssapi --with-system-tzdata=/usr/share/zoneinfo
make -j2
make install
for binary in postgres initdb pg_ctl pg_isready psql createdb dropdb pg_dump pg_restore; do test -x "$PREFIX/bin/$binary"; strip -x "$PREFIX/bin/$binary" 2>/dev/null || true; done
LIBPQ="$PREFIX/lib/libpq.5.dylib"
test -f "$LIBPQ"
command -v install_name_tool >/dev/null 2>&1 || { echo "install_name_tool is required to make libpq archive-local" >&2; exit 1; }
install_name_tool -id "@loader_path/libpq.5.dylib" "$LIBPQ"
for binary in postgres initdb pg_ctl pg_isready psql createdb dropdb pg_dump pg_restore; do
  if otool -L "$PREFIX/bin/$binary" | grep -F "$LIBPQ" >/dev/null; then
    install_name_tool -change "$LIBPQ" "@loader_path/../lib/libpq.5.dylib" "$PREFIX/bin/$binary"
  fi
done
mkdir -p "$ROOT/.backend-team/artifacts"
tar -cJf "$ROOT/.backend-team/artifacts/postgresql-${VERSION}-darwin-${ARCH}.tar.xz" -C "$WORK" "postgresql-${VERSION}-${ARCH}"
shasum -a 256 "$ROOT/.backend-team/artifacts/postgresql-${VERSION}-darwin-${ARCH}.tar.xz"
