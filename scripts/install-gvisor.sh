#!/usr/bin/env sh
# Install gVisor (runsc) on a Linux Docker host and register it as a runtime, so
# the OPT-IN secure profile can boot. The default runtime is runc (works on any
# host, no setup) — run this and set SANDBOX_RUNTIME=runsc only to opt into the
# hardened, fail-closed profile. gVisor needs NO KVM (the systrap platform is
# userspace), so this works on ordinary VPS hosts.
#
# Run as root on the DOCKER HOST (not inside a container):
#   sudo sh scripts/install-gvisor.sh && sudo systemctl restart docker
set -eu

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) ;;
  *) echo "Unsupported arch: $ARCH (gVisor ships x86_64 and aarch64)"; exit 1 ;;
esac

# Since release-20261102.0 a release ships as ONE tarball (the per-file runsc /
# containerd-shim-runsc-v1 URLs are gone): runsc, the shim, and a gvisor-bin/
# directory holding the sentry and its helpers. runsc looks for gvisor-bin/ BESIDE
# itself and refuses to start a sandbox without it ("sidecar gvisor_sentry not
# usable"), so all three land together in /usr/local/bin. bz2, not zstd: tar -j is
# available everywhere, zstd often isn't.
command -v bzip2 >/dev/null 2>&1 || { echo "bzip2 is required to unpack the gVisor release (apt-get install bzip2)"; exit 1; }
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
TMP="$(mktemp -d)"
echo "[gvisor] downloading the gVisor release for ${ARCH}..."
wget -q "${URL}/gvisor.tar.bz2" "${URL}/gvisor.tar.bz2.sha512" -P "$TMP"
( cd "$TMP" && sha512sum -c gvisor.tar.bz2.sha512 )
tar -xjf "$TMP/gvisor.tar.bz2" -C "$TMP" runsc containerd-shim-runsc-v1 gvisor-bin
chmod -R a+rX "$TMP/runsc" "$TMP/containerd-shim-runsc-v1" "$TMP/gvisor-bin"
rm -rf /usr/local/bin/gvisor-bin
mv "$TMP/runsc" "$TMP/containerd-shim-runsc-v1" "$TMP/gvisor-bin" /usr/local/bin/
rm -rf "$TMP"

echo "[gvisor] registering the runsc runtime with Docker..."
# --net-raw=true keeps CAP_NET_RAW in sandbox containers. gVisor strips it by
# default, but the legacy iptables backend can't initialize its `filter` table
# without it ("Table does not exist") — so the fail-closed egress firewall in
# sandbox-entrypoint.sh would kill EVERY container the moment SANDBOX_ALLOW_NETWORK
# is on. Within gVisor's virtualized per-container netstack raw packets stay
# confined and still traverse the OUTPUT chain, so this is a safe trade for a
# working egress filter. (Args after `--` are written to runtimeArgs.)
/usr/local/bin/runsc install -- --net-raw=true   # writes runtimes.runsc into /etc/docker/daemon.json

# userns-remap is a multi-tenant REQUIREMENT: without it a container-escape-as-root
# maps to host root over the bind-mounted workspaces of other tenants.
DJ=/etc/docker/daemon.json
if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  jq '. + {"userns-remap": (.["userns-remap"] // "default")}' "$DJ" > "$tmp" && mv "$tmp" "$DJ"
  echo "[gvisor] userns-remap enabled (default)."
else
  echo "[gvisor] WARNING: jq not found — could not auto-enable userns-remap."
  echo "          Add  \"userns-remap\": \"default\"  to $DJ manually (multi-tenant requirement)."
fi

echo "[gvisor] done. Now: sudo systemctl restart docker"
echo "         verify:  docker info --format '{{json .Runtimes}}'   (expect runsc)"
echo "                  docker run --rm --runtime=runsc alpine uname -r   (expect *-gvisor)"
