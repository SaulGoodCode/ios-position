#!/bin/bash
# ============================================================
# LocSpoof All-in-One Deployment Script
# Runs ALL services on a single Linux VM via Docker
# ============================================================
#
# Prerequisites:
#   - Docker + Docker Compose installed
#   - VM network adapter set to Bridged mode
#
# Usage:
#   bash setup.sh                     # Auto-detect VM IP
#   bash setup.sh 192.168.1.60        # Manual IP
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[-]${NC} $1"; }

# ============================================================
# Detect or accept IP
# ============================================================
if [ -n "$1" ]; then
    VM_IP="$1"
else
    VM_IP=$(ip -4 route get 8.8.8.8 2>/dev/null | awk '{print $7; exit}')
    [ -z "$VM_IP" ] && VM_IP=$(hostname -I | awk '{print $1}')
fi

if [ -z "$VM_IP" ]; then
    err "Could not detect VM IP."
    echo "    Usage: bash setup.sh <VM_LAN_IP>"
    exit 1
fi

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  LocSpoof All-in-One Deployment${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "  VM LAN IP:  ${GREEN}${VM_IP}${NC}"
echo ""

# Navigate to deploy directory
cd "$(dirname "$0")"

# ============================================================
# Write .env
# ============================================================
cat > .env << EOF
VM_IP=$VM_IP
VPN_USERNAME=user
VPN_PASSWORD=changeme
EOF
log "Created .env (VM_IP=$VM_IP)"

# ============================================================
# Check Docker
# ============================================================
if ! command -v docker &> /dev/null; then
    err "Docker not installed. Install it first:"
    echo "    curl -fsSL https://get.docker.com | sh"
    echo "    sudo usermod -aG docker \$USER"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    err "Docker Compose plugin not found."
    echo "    Install: sudo apt-get install docker-compose-plugin"
    exit 1
fi

log "Docker and Docker Compose detected."

# ============================================================
# Build and start all services
# ============================================================
log "Building Docker images (first time may take 2-3 min)..."
docker compose build --parallel 2>&1 | tail -5

log "Starting all services..."
docker compose up -d

# ============================================================
# Wait for services
# ============================================================
log "Waiting for services to initialize..."

# Wait for API
WAIT=0
until curl -sf "http://localhost:8000/health" > /dev/null 2>&1; do
    sleep 2
    WAIT=$((WAIT + 2))
    if [ $WAIT -ge 60 ]; then
        err "API server failed to start within 60s"
        docker compose logs api
        exit 1
    fi
done
log "API server is ready."

# Wait for VPN
WAIT=0
until docker compose logs vpn 2>/dev/null | grep -q "VPN Server Ready"; do
    sleep 2
    WAIT=$((WAIT + 2))
    if [ $WAIT -ge 60 ]; then
        warn "VPN may not be ready yet. Check: docker compose logs vpn"
        break
    fi
done
log "VPN server is ready."

# ============================================================
# Done!
# ============================================================
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  All Services Running!${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Services:${NC}"
echo -e "    Web UI:    ${GREEN}http://${VM_IP}:8000/${NC}"
echo -e "    API:       ${GREEN}http://${VM_IP}:8000/api/status${NC}"
echo -e "    Profile:   ${GREEN}http://${VM_IP}:8000/install.mobileconfig${NC}"
echo -e "    PAC:       ${GREEN}http://${VM_IP}:8000/proxy.pac${NC}"
echo -e "    Proxy:     ${GREEN}${VM_IP}:8443${NC}"
echo -e "    VPN:       ${GREEN}${VM_IP} (IKEv2 UDP 500/4500)${NC}"
echo ""
echo -e "  ${CYAN}VPN Credentials:${NC}"
echo -e "    Username:  user"
echo -e "    Password:  changeme"
echo ""
echo -e "  ${CYAN}=== iPhone Setup ===${NC}"
echo ""
echo -e "  1. Safari -> ${GREEN}http://${VM_IP}:8000/install.mobileconfig?username=user&password=changeme${NC}"
echo -e "  2. Settings -> tap profile -> Install"
echo -e "  3. Settings -> General -> About -> Certificate Trust"
echo -e "     -> Enable 'LocSpoof Root CA'"
echo -e "  4. Settings -> VPN -> Toggle ON"
echo -e "  5. ${GREEN}http://${VM_IP}:8000/${NC} -> Pick location -> Apply"
echo ""
echo -e "  ${CYAN}Commands:${NC}"
echo -e "    Logs:     docker compose logs -f"
echo -e "    Stop:     docker compose down"
echo -e "    Restart:  docker compose restart"
echo ""
echo -e "${CYAN}============================================${NC}"
