#!/usr/bin/env bash
# HTTPS on the LAN: browsers only allow the microphone on https:// pages (or on the
# server itself), so caption pages on phones and other PCs need HTTPS. This makes, in the given
# directory (default: config/tls):
#   ca.crt / ca.key           a small certificate authority for this installation (made once, kept)
#   server.crt / server.key   a certificate for localhost, 127.0.0.1, this machine's IPv4 addresses
#                             and its .local name, signed by that CA (made again on every run)
# Install ca.crt once on every device that opens https://<this machine>:8443 (the server offers it
# at http://<this machine>:8765/ca.crt). Then there is no certificate warning, also not in OBS.
# Extra names or addresses: LAN_NAMES="mosque.lan 10.0.0.5" scripts/lan-cert.sh
set -euo pipefail
dir="${1:-config/tls}"
mkdir -p "$dir"
chmod 700 "$dir"
cd "$dir"
umask 077

if [ ! -f ca.key ] || [ ! -f ca.crt ]; then
  openssl genrsa -out ca.key 3072 2>/dev/null
  openssl req -x509 -new -key ca.key -sha256 -days 3650 \
    -subj "/O=Turjuman/CN=Turjuman local CA ($(hostname -s 2>/dev/null || echo server))" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out ca.crt
fi

# Subject alternative names: localhost, loopback, every IPv4 of this machine, its .local name.
san="DNS:localhost,IP:127.0.0.1"
host="$(hostname -s 2>/dev/null || true)"
[ -n "$host" ] && san="$san,DNS:$host.local"
ips="$( (ifconfig 2>/dev/null || ip -4 addr 2>/dev/null || true) |
  awk '/inet /{sub(/\/.*/, "", $2); print $2}' | grep -v '^127\.' | sort -u || true)"
for ip in $ips; do san="$san,IP:$ip"; done
for name in ${LAN_NAMES:-}; do
  if [[ "$name" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then san="$san,IP:$name"; else san="$san,DNS:$name"; fi
done

openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/O=Turjuman/CN=${host:-localhost}" -out server.csr
printf '%s\n' \
  "subjectAltName=$san" \
  "basicConstraints=CA:FALSE" \
  "keyUsage=critical,digitalSignature,keyEncipherment" \
  "extendedKeyUsage=serverAuth" >server.ext
# 825 days: the longest validity iOS and macOS accept for a server certificate.
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 \
  -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext
chmod 600 ca.key server.key
chmod 644 ca.crt server.crt
echo "HTTPS certificate for: ${san//,/ }"
echo "CA to install on each device: $(pwd)/ca.crt"
