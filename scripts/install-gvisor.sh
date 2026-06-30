#!/usr/bin/env sh
# Install gVisor (runsc) on a Linux Docker host and register it as a runtime, so
# the secure profile (SANDBOX_RUNTIME=runsc, the default) can boot. gVisor needs
# NO KVM (the systrap platform is userspace), so this works on ordinary VPS hosts.
#
# Run as root on the DOCKER HOST (not inside a container):
#   sudo sh scripts/install-gvisor.sh && sudo systemctl restart docker
set -eu

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) ;;
  *) echo "Unsupported arch: $ARCH (gVisor ships x86_64 and aarch64)"; exit 1 ;;
esac

URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
TMP="$(mktemp -d)"
echo "[gvisor] downloading runsc + shim for ${ARCH}..."
for f in runsc containerd-shim-runsc-v1; do
  wget -q "${URL}/${f}" "${URL}/${f}.sha512" -P "$TMP"
done
( cd "$TMP" && sha512sum -c runsc.sha512 containerd-shim-runsc-v1.sha512 )
chmod a+rx "$TMP/runsc" "$TMP/containerd-shim-runsc-v1"
mv "$TMP/runsc" "$TMP/containerd-shim-runsc-v1" /usr/local/bin/
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
