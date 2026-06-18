#!/bin/bash
# VPN container entrypoint
# Uses shared certs from the API container (same CA)

set -e

# Install dnsmasq for DNS hijacking
apk add --no-cache dnsmasq 2>/dev/null || true

CERTS_DIR="${CERTS_DIR:-/certs}"
IPSEC_DIR="/etc/ipsec.d"

VPN_HOST="${VPN_HOST:?Set VPN_HOST to VM LAN IP}"
VPN_USERNAME="${VPN_USERNAME:-user}"
VPN_PASSWORD="${VPN_PASSWORD:-changeme}"

log() { echo "[VPN] $1"; }

# ============================================================
# Wait for CA cert from API container
# ============================================================
log "Waiting for CA certificate..."
WAIT=0
while [ ! -f "$CERTS_DIR/ca.crt" ] && [ $WAIT -lt 30 ]; do
    sleep 1
    WAIT=$((WAIT + 1))
done

if [ ! -f "$CERTS_DIR/ca.crt" ]; then
    log "ERROR: CA cert not found after 30s. Is API container running?"
    exit 1
fi
log "CA certificate found."

# ============================================================
# Generate VPN server cert if missing
# ============================================================
if [ ! -f "$CERTS_DIR/vpn_server.crt" ]; then
    log "Generating VPN server certificate for $VPN_HOST..."

    if [ ! -f "$CERTS_DIR/vpn_server.key" ]; then
        openssl genrsa -out "$CERTS_DIR/vpn_server.key" 2048
    fi

    openssl req -new \
        -key "$CERTS_DIR/vpn_server.key" \
        -out /tmp/vpn_server.csr \
        -subj "/CN=$VPN_HOST"

    openssl x509 -req -days 825 \
        -in /tmp/vpn_server.csr \
        -CA "$CERTS_DIR/ca.crt" \
        -CAkey "$CERTS_DIR/ca.key" \
        -CAcreateserial \
        -out "$CERTS_DIR/vpn_server.crt" \
        -extfile <(printf "subjectAltName=IP:%s,DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth" "$VPN_HOST" "$VPN_HOST")

    rm -f /tmp/vpn_server.csr "$CERTS_DIR/ca.srl"
    log "VPN server certificate generated."
else
    log "VPN server certificate exists."
fi

# ============================================================
# Install certs into strongSwan
# ============================================================
cp "$CERTS_DIR/ca.crt"         "$IPSEC_DIR/cacerts/"
cp "$CERTS_DIR/vpn_server.crt" "$IPSEC_DIR/certs/server.crt"
cp "$CERTS_DIR/vpn_server.key" "$IPSEC_DIR/private/server.key"
chmod 600 "$IPSEC_DIR/private/server.key"

# Verify cert and key match
CERT_MOD=$(openssl x509 -noout -modulus -in "$IPSEC_DIR/certs/server.crt" 2>/dev/null | md5sum)
KEY_MOD=$(openssl rsa -noout -modulus -in "$IPSEC_DIR/private/server.key" 2>/dev/null | md5sum)
if [ "$CERT_MOD" = "$KEY_MOD" ]; then
    log "Certificate and key match."
else
    log "WARNING: Certificate and key DO NOT match!"
fi

# Show cert details
log "Server cert subject:"
openssl x509 -noout -subject -in "$IPSEC_DIR/certs/server.crt"
log "Server cert SAN:"
openssl x509 -noout -ext subjectAltName -in "$IPSEC_DIR/certs/server.crt" 2>/dev/null || true

# ============================================================
# strongSwan configuration
# ============================================================
cat > /etc/ipsec.conf << EOF
config setup
    uniqueids=no
    charondebug="ike 2, knl 1, cfg 2, enc 1, net 1, esp 1"

conn ikev2-vpn
    auto=add
    compress=no
    type=tunnel
    keyexchange=ikev2
    fragmentation=yes
    forceencaps=yes
    dpdaction=clear
    dpddelay=300s
    rekey=no
    ike=aes256gcm16-sha256-ecp256,aes256-sha256-ecp256,aes256-sha384-ecp384,aes128gcm16-sha256-ecp256!
    esp=aes256gcm16-ecp256,aes256-sha256,aes256-sha384,aes128gcm16!
    left=%any
    leftid=${VPN_HOST}
    leftauth=pubkey
    leftcert=server.crt
    leftsendcert=always
    leftsubnet=0.0.0.0/0
    right=%any
    rightauth=eap-mschapv2
    rightsendcert=never
    rightsourceip=10.10.10.2-10.10.10.254
    rightdns=10.10.10.1
    eap_identity=%any
EOF

# Add multiple EAP identity entries to handle any identity format iOS might send
# iOS may send "user", "user@locspoof.local", or other formats
USER_SHORT=$(echo "$VPN_USERNAME" | cut -d'@' -f1)
cat > /etc/ipsec.secrets << EOF
: RSA server.key
${VPN_USERNAME} : EAP "${VPN_PASSWORD}"
${USER_SHORT} : EAP "${VPN_PASSWORD}"
EOF
chmod 600 /etc/ipsec.secrets
log "EAP secrets configured for identities: ${VPN_USERNAME}, ${USER_SHORT}"

# Ensure charon plugin directory exists and list available plugins
mkdir -p /etc/strongswan.d/charon
log "Checking charon plugin files..."
PLUGIN_DIR=""
for d in /usr/lib/ipsec/plugins /usr/lib/strongswan/plugins /usr/lib/x86_64-linux-gnu/ipsec/plugins; do
    if [ -d "$d" ]; then
        PLUGIN_DIR="$d"
        break
    fi
done

if [ -n "$PLUGIN_DIR" ]; then
    log "Plugin directory: $PLUGIN_DIR"
    log "EAP plugins found:"
    ls "$PLUGIN_DIR" 2>/dev/null | grep -i eap || log "  (no EAP plugin .so files found!)"
    log "All plugins:"
    ls "$PLUGIN_DIR" 2>/dev/null | head -30
else
    log "WARNING: No charon plugin directory found!"
fi

# Check charon load files
if [ -d /etc/strongswan.d/charon ]; then
    log "Charon load configs:"
    ls /etc/strongswan.d/charon/ 2>/dev/null | head -20 || log "  (no .conf files)"
fi

cat > /etc/strongswan.conf << 'STRONGSWAN_EOF'
charon {
    install_routes = yes
    install_virtual_ip = yes
    dns1 = 10.10.10.1
}
STRONGSWAN_EOF

# ============================================================
# Network setup
# ============================================================
log "Configuring network..."

# These sysctls are set here (not in docker-compose) because
# network_mode: host doesn't allow sysctl directives.
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
echo 0 > /proc/sys/net/ipv4/conf/all/send_redirects 2>/dev/null || true
echo 0 > /proc/sys/net/ipv4/conf/all/accept_redirects 2>/dev/null || true
echo 0 > /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null || true
echo 0 > /proc/sys/net/ipv4/conf/default/rp_filter 2>/dev/null || true

DEFAULT_IF=$(ip route show default 2>/dev/null | awk '/default/ {print $5}' | head -1)
[ -z "$DEFAULT_IF" ] && DEFAULT_IF="eth0"
log "Default interface: $DEFAULT_IF"

iptables -A INPUT -p udp --dport 500 -j ACCEPT
iptables -A INPUT -p udp --dport 4500 -j ACCEPT
iptables -A FORWARD -s 10.10.10.0/24 -j ACCEPT
iptables -A FORWARD -d 10.10.10.0/24 -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.10.10.0/24 -o "$DEFAULT_IF" -j MASQUERADE
iptables -t mangle -A FORWARD -s 10.10.10.0/24 -p tcp \
    --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu

# ============================================================
# Pre-start verification
# ============================================================
log "Verifying strongSwan configuration..."

# Start ipsec in background to test config
ipsec start --nofork &
IPSEC_PID=$!
sleep 2

# Check if ipsec is running
if kill -0 $IPSEC_PID 2>/dev/null; then
    log "strongSwan started successfully (PID: $IPSEC_PID)"

    # Check loaded plugins
    log "Checking loaded EAP plugins..."
    ipsec statusall 2>/dev/null | grep -i "eap" || log "  (no EAP info in statusall)"

    # Check connection config
    log "Connection configuration:"
    ipsec status 2>/dev/null || log "  (status check failed)"

    # Stop for clean restart
    ipsec stop 2>/dev/null || kill $IPSEC_PID 2>/dev/null || true
    sleep 1
    log "Pre-start verification complete. Restarting in foreground..."
else
    log "ERROR: strongSwan failed to start! Check configuration."
    wait $IPSEC_PID 2>/dev/null
    exit 1
fi

# ============================================================
# Start
# ============================================================
log ""
log "============================================"
log "  VPN Server Ready"
log "============================================"
log "  Host:     $VPN_HOST"
log "  Type:     IKEv2"
log "  Username: $VPN_USERNAME"
log "  Password: $VPN_PASSWORD"
log "  Pool:     10.10.10.0/24"
log "============================================"
log ""

# ============================================================
# DNS Hijacking + Transparent Proxy Setup
# ============================================================
log "Setting up DNS hijacking and transparent proxy..."

# Add IP alias for dnsmasq and DNAT target
ip addr add 10.10.10.1/32 dev lo 2>/dev/null || log "IP alias 10.10.10.1 already exists"

# Start dnsmasq on port 15353 (port 53 is blocked by Docker networking)
# Docker's iptables/nftables interfere with UDP port 53 even with host networking,
# causing DNS queries to silently time out. Using a non-standard port avoids this.
# --bind-interfaces is critical: without it, dnsmasq creates dual-stack sockets
# and IPv6 queries fail silently. With it, dnsmasq binds directly at socket creation.
dnsmasq --keep-in-foreground \
    --bind-interfaces \
    --listen-address=127.0.0.1 \
    --port=15353 \
    --no-resolv \
    --server=8.8.8.8 --server=8.8.4.4 \
    --address=/gs-loc.apple.com/10.10.10.1 \
    --address=/gs-loc-cn.apple.com/10.10.10.1 \
    --log-queries --log-facility=- &
DNSMASQ_PID=$!
log "dnsmasq started on port 15353 (PID: $DNSMASQ_PID)"

# iptables: redirect DNS port 53 → 15353 (workaround for Docker port 53 interference)
iptables -t nat -I PREROUTING 1 -p udp -d 10.10.10.1 --dport 53 -j REDIRECT --to-port 15353
iptables -t nat -I PREROUTING 2 -p tcp -d 10.10.10.1 --dport 53 -j REDIRECT --to-port 15353
log "iptables PREROUTING DNS redirect 53→15353 added (UDP+TCP)"

# iptables: redirect port 443 to 10.10.10.1 → proxy on 8443
iptables -t nat -I PREROUTING 3 -p tcp --dport 443 -d 10.10.10.1 -j DNAT --to-destination 127.0.0.1:8443
log "iptables PREROUTING DNAT added"

# iptables: redirect UID 1000 (mitmproxy user) outbound port 443 to dummy proxy
iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner --uid-owner 1000 -j DNAT --to-destination 127.0.0.1:8444
log "iptables OUTPUT DNAT for UID 1000 added"

exec /usr/sbin/ipsec start --nofork
