#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo "Linux build dependencies must be prepared on Linux" >&2
  exit 1
fi

case "$(dpkg --print-architecture)" in
  arm64) mirrors="ports.ubuntu.com" ;;
  *) mirrors="azure.archive.ubuntu.com archive.ubuntu.com security.ubuntu.com" ;;
esac

resolve_mirrors() {
  for mirror in $mirrors; do
    if ! timeout 8s getent ahostsv4 "$mirror" >/dev/null; then
      echo "Cannot resolve Ubuntu package mirror: $mirror" >&2
      return 1
    fi
  done
}

if ! resolve_mirrors; then
  # Only repair the disposable GitHub runner; never change a developer's DNS.
  if [ "${GITHUB_ACTIONS:-}" != true ] || ! command -v resolvectl >/dev/null; then
    echo "Restore DNS resolution before preparing Linux build dependencies" >&2
    exit 1
  fi
  interface="$(ip -o -4 route show default | awk '{print $5; exit}')"
  if [ -z "$interface" ]; then
    echo "Cannot find the runner's default network interface" >&2
    exit 1
  fi
  echo "Repairing DNS on disposable GitHub runner interface $interface"
  sudo resolvectl dns "$interface" 1.1.1.1 8.8.8.8
  sudo resolvectl domain "$interface" '~.'
  sudo resolvectl flush-caches
  resolve_mirrors
fi

timeout 180s sudo env DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::ForceIPv4=true -o Acquire::Retries=1 -o Acquire::http::Timeout=20 \
  -o Acquire::https::Timeout=20 -o APT::Update::Error-Mode=any update
timeout 180s sudo env DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::ForceIPv4=true -o Acquire::Retries=1 -o Acquire::http::Timeout=20 \
  -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=30 \
  install -y meson ninja-build pkg-config libglib2.0-dev libgdk-pixbuf-2.0-dev binutils
