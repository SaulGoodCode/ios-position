#!/bin/bash
# ============================================================
# strongSwan Docker Entrypoint
# Uses pre-generated certs from shared folder, or generates
# new ones on first run.
# ============================================================
set -e

CERTS_DIR="${CERTS_DIR:-/certs}"
IPSEC_DIR="/etc/ipsec.d"

VPN_HOST="${VPN_HOST:?Set VPN_HOST env var (VM LAN IP)}"
VPN_USERNAME="${VPN_USERNAME:-user@locspoof.local}"
VPN_PASSWORD="${VPN_PASSWORD:-changeme}"

log() { echo "[LocSpoof VPN] $1"; }

# ============================================================
# Step 1: Check or generate certificates
# ============================================================
if [ -f "$CERTS_DIR/ca.crt" ] && [ -f "$CERTS_DIR/ca.key" ]; then
    log "Using pre-generated certificates from $CERTS_DIR"
else
    log "No certificates found in $CERTS_DIR, generating..."
    mkdir -p "$CERTS_DIR"

    openssl genrsa -out "$CERTS_DIR/ca.key" 4096
    openssl req -new -x509 -days 3650 \
        -key "$CERTS_DIR/ca.key" \
        -out "$CERTS_DIR/ca.crt" \
        -subj "/CN=LocSpoof Root CA/O=LocSpoof" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
    openssl x509 -in "$CERTS_DIR/ca.crt" -outform DER -out "$CERTS_DIR/ca.cer"

    log "CA certificate generated. Share $CERTS_DIR/ca.cer with Windows."
fi

# Generate server cert if missing
if [ ! -f "$CERTS_DIR/vpn_server.crt" ]; then
    log "Generating VPN server certificate for $VPN_HOST..."
    openssl genrsa -out "$CERTS_DIR/vpn_server.key" 2048

    openssl req -new \
        -key "$CERTS_DIR/vpn_server.key" \
        -out /tmp/server.csr \
        -subj "/CN=$VPN_HOST"

    openssl x509 -req -days 825 \
        -in /tmp/server.csr \
        -CA "$CERTS_DIR/ca.crt" \
        -CAkey "$CERTS_DIR/ca.key" \
        -CAcreateserial \
        -out "$CERTS_DIR/vpn_server.crt" \
        -extfile <(printf "subjectAltName=IP:%s,DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth" "$VPN_HOST" "$VPN_HOST")

    rm -f /tmp/server.csr "$CERTS_DIR/ca.srl"
    log "Server certificate generated."
fi

# ============================================================
# Step 2: Install certs into strongSwan
# ============================================================
cp "$CERTS_DIR/ca.crt"          "$IPSEC_DIR/cacerts/"
cp "$CERTS_DIR/vpn_server.crt"  "$IPSEC_DIR/certs/server.crt"
cp "$CERTS_DIR/vpn_server.key"  "$IPSEC_DIR/private/server.key"
chmod 600 "$IPSEC_DIR/private/server.key"

# ============================================================
# Step 3: Write strongSwan configuration
# ============================================================
cat > /etc/ipsec.conf << EOF
config setup
    uniqueids=never
    charondebug="ike 1, knl 1, cfg 0"

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
    left=%any
    leftid=@${VPN_HOST}
    leftcert=server.crt
    leftsendcert=always
    leftsubnet=0.0.0.0/0
    right=%any
    rightid=%any
    rightauth=eap-mschapv2
    rightsourceip=10.10.10.0/24
    rightdns=8.8.8.8,8.8.4.4
    rightsendcert=never
    eap_identity=%identity
EOF

cat > /etc/ipsec.secrets << EOF
: RSA server.key
${VPN_USERNAME} : EAP "${VPN_PASSWORD}"
EOF
chmod 600 /etc/ipsec.secrets

cat > /etc/strongswan.conf << EOF
charon {
    install_routes = yes
    install_virtual_ip = yes
    dns1 = 8.8.8.8
    dns2 = 8.8.4.4
}
EOF

# ============================================================
# Step 4: Network setup
# ============================================================
log "Configuring network..."
echo 1 > /proc/sys/net/ipv4/ip_forward

DEFAULT_IF=$(ip route show default 2>/dev/null | awk '/default/ {print $5}' | head -1)
[ -z "$DEFAULT_IF" ] && DEFAULT_IF="eth0"
log "Default interface: $DEFAULT_IF"

iptables -F 2>/dev/null || true
iptables -t nat -F 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true

iptables -A INPUT -p udp --dport 500 -j ACCEPT
iptables -A INPUT -p udp --dport 4500 -j ACCEPT
iptables -A FORWARD -s 10.10.10.0/24 -j ACCEPT
iptables -A FORWARD -d 10.10.10.0/24 -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.10.10.0/24 -o "$DEFAULT_IF" -j MASQUERADE
iptables -t mangle -A FORWARD -s 10.10.10.0/24 -p tcp \
    --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu

# ============================================================
# Step 5: Start
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

exec /usr/sbin/ipsec start --nofork
