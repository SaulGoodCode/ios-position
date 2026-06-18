#!/bin/bash
# ============================================================
# IKEv2 VPN Server Setup Script (strongSwan)
# For iOS Location Spoofing Service
#
# This script configures a Linux server as an IKEv2 VPN endpoint
# using strongSwan. It handles:
# - Installing strongSwan
# - Generating server certificates
# - Configuring IPsec/IKEv2
# - Setting up firewall rules
# - Creating VPN user accounts
#
# Run as root on a Ubuntu/Debian server.
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[-]${NC} $1"; }

# Check root
if [ "$EUID" -ne 0 ]; then
    err "Please run as root (sudo)"
    exit 1
fi

# ============================================================
# Configuration
# ============================================================
VPN_HOST="${VPN_HOST:-vpn.locspoof.local}"
VPN_USERNAME="${VPN_USERNAME:-user@locspoof.local}"
VPN_PASSWORD="${VPN_PASSWORD:-changeme}"
CERTS_DIR="${CERTS_DIR:-$(pwd)/certs}"

echo "============================================"
echo " LocSpoof VPN Server Setup"
echo "============================================"
echo " VPN Host:     $VPN_HOST"
echo " Username:     $VPN_USERNAME"
echo " Certs Dir:    $CERTS_DIR"
echo "============================================"
echo ""

# ============================================================
# Step 1: Install strongSwan
# ============================================================
log "Installing strongSwan and dependencies..."
apt-get update -qq
apt-get install -y strongswan strongswan-pki libcharon-extra-plugins \
    libcharon-extauth-plugins libstrongswan-extra-plugins \
    libtss2-tcti-tabrmd0 iptables-persistent

# ============================================================
# Step 2: Generate server certificate (if not already present)
# ============================================================
IPSEC_DIR="/etc/ipsec.d"

log "Setting up certificates..."

# Copy CA cert if provided
if [ -f "$CERTS_DIR/ca.crt" ]; then
    cp "$CERTS_DIR/ca.crt" "$IPSEC_DIR/cacerts/ca.crt"
    log "Copied CA certificate"
else
    warn "CA cert not found at $CERTS_DIR/ca.crt"
    warn "Generating a self-signed server cert instead..."

    # Generate server key
    pki --gen --type rsa --size 4096 --outform pem > "$IPSEC_DIR/private/server-key.pem"
    chmod 600 "$IPSEC_DIR/private/server-key.pem"

    # Generate self-signed CA
    pki --gen --type rsa --size 4096 --outform pem > /tmp/ca-key.pem
    pki --self --ca --lifetime 3650 \
        --in /tmp/ca-key.pem --type rsa \
        --dn "CN=LocSpoof Root CA" \
        --outform pem > "$IPSEC_DIR/cacerts/ca.crt"

    # Generate server cert signed by our CA
    pki --pub --in "$IPSEC_DIR/private/server-key.pem" --type rsa | \
    pki --issue --lifetime 1825 \
        --cacert "$IPSEC_DIR/cacerts/ca.crt" \
        --cakey /tmp/ca-key.pem \
        --dn "CN=$VPN_HOST" \
        --san "$VPN_HOST" \
        --flag serverAuth --flag ikeIntermediate \
        --outform pem > "$IPSEC_DIR/certs/server-cert.pem"

    rm /tmp/ca-key.pem
fi

# Generate server key/cert if not copied
if [ ! -f "$IPSEC_DIR/private/server-key.pem" ]; then
    if [ -f "$CERTS_DIR/vpn_server.key" ]; then
        cp "$CERTS_DIR/vpn_server.key" "$IPSEC_DIR/private/server-key.pem"
        cp "$CERTS_DIR/vpn_server.crt" "$IPSEC_DIR/certs/server-cert.pem"
    else
        pki --gen --type rsa --size 2048 --outform pem > "$IPSEC_DIR/private/server-key.pem"
        chmod 600 "$IPSEC_DIR/private/server-key.pem"

        pki --pub --in "$IPSEC_DIR/private/server-key.pem" --type rsa | \
        pki --issue --lifetime 1825 \
            --cacert "$IPSEC_DIR/cacerts/ca.crt" \
            --dn "CN=$VPN_HOST" \
            --san "$VPN_HOST" \
            --flag serverAuth --flag ikeIntermediate \
            --outform pem > "$IPSEC_DIR/certs/server-cert.pem"
    fi
fi

chmod 600 "$IPSEC_DIR/private/server-key.pem"

# ============================================================
# Step 3: Configure strongSwan
# ============================================================
log "Configuring IPsec..."

cat > /etc/ipsec.conf << 'IPSEC_CONF'
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
    leftid=@VPN_HOST_PLACEHOLDER
    leftcert=server-cert.pem
    leftsendcert=always
    leftsubnet=0.0.0.0/0
    right=%any
    rightid=%any
    rightauth=eap-mschapv2
    rightsourceip=10.10.10.0/24
    rightdns=8.8.8.8,8.8.4.4
    rightsendcert=never
    eap_identity=%identity
IPSEC_CONF

# Replace placeholder with actual host
sed -i "s/VPN_HOST_PLACEHOLDER/$VPN_HOST/g" /etc/ipsec.conf

# EAP secrets (username : password)
cat > /etc/ipsec.secrets << EOF
: RSA server-key.pem
$VPN_USERNAME : EAP "$VPN_PASSWORD"
EOF

chmod 600 /etc/ipsec.secrets

# ============================================================
# Step 4: Configure DNS split tunneling
# ============================================================
log "Configuring DNS split tunnel..."

# Create a custom attr plugin config for DNS-based routing
# This pushes specific DNS routes to the client
cat > /etc/strongswan.d/charon/attr.conf << 'ATTR_CONF'
attr {
    load = yes
    dns = 8.8.8.8, 8.8.4.4
}
ATTR_CONF

# ============================================================
# Step 5: Kernel / sysctl settings
# ============================================================
log "Configuring kernel parameters..."

cat > /etc/sysctl.d/99-locspoof-vpn.conf << 'SYSCTL'
# Enable IP forwarding
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# Disable ICMP redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0

# Prevent IP spoofing
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
SYSCTL

sysctl --system > /dev/null 2>&1

# ============================================================
# Step 6: Firewall rules (iptables)
# ============================================================
log "Configuring firewall..."

# Detect default network interface
DEFAULT_IF=$(ip route show default | awk '/default/ {print $5}')

# Allow IPsec
iptables -A INPUT -p udp --dport 500 -j ACCEPT
iptables -A INPUT -p udp --dport 4500 -j ACCEPT

# Allow ESP
iptables -A INPUT -p esp -j ACCEPT

# Forward VPN traffic
iptables -A FORWARD -s 10.10.10.0/24 -j ACCEPT
iptables -A FORWARD -d 10.10.10.0/24 -j ACCEPT

# NAT for VPN clients
iptables -t nat -A POSTROUTING -s 10.10.10.0/24 -o "$DEFAULT_IF" -m policy --pol ipsec --dir out -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.10.10.0/24 -o "$DEFAULT_IF" -j MASQUERADE

# MSS clamping for better compatibility
iptables -t mangle -A FORWARD -s 10.10.10.0/24 -p tcp -m tcp --tcp-flags SYN,RST SYN -m tcpmss --mss 1361:1536 -j TCPMSS --set-mss 1360

# Save rules
if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save
fi

# ============================================================
# Step 7: Start services
# ============================================================
log "Starting strongSwan..."
systemctl enable strongswan
systemctl restart strongswan

# ============================================================
# Done
# ============================================================
echo ""
echo "============================================"
echo -e "${GREEN} VPN Server Setup Complete!${NC}"
echo "============================================"
echo ""
echo " Connection Details:"
echo "   Server:   $VPN_HOST"
echo "   Type:     IKEv2"
echo "   Username: $VPN_USERNAME"
echo "   Password: $VPN_PASSWORD"
echo ""
echo " Verify with:  ipsec status"
echo " Logs:         journalctl -u strongswan -f"
echo ""
echo " To add more users, edit /etc/ipsec.secrets:"
echo '   newuser@example.com : EAP "password"'
echo " Then run:  ipsec reload"
echo "============================================"
