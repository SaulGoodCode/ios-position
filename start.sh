#!/bin/bash
# ============================================================
# LocSpoof - Development Startup Script
# ============================================================
# This script starts all services for local development:
#   1. FastAPI backend (port 8000)
#   2. MITM proxy (port 8443)
#
# Prerequisites:
#   - Python 3.10+
#   - pip install -r requirements.txt
#   - python scripts/generate_ca.py (first time only)
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "========================================"
echo "  LocSpoof - iOS Location Spoofing"
echo "========================================"
echo -e "${NC}"

# Check certs
if [ ! -f "certs/ca.crt" ]; then
    echo -e "${YELLOW}[!] Certificates not found. Generating...${NC}"
    python scripts/generate_ca.py
    echo ""
fi

# Create data dir
mkdir -p data

# Kill background processes on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}[*] Shutting down...${NC}"
    kill $API_PID $PROXY_PID 2>/dev/null
    wait $API_PID $PROXY_PID 2>/dev/null
    echo -e "${GREEN}[+] All services stopped.${NC}"
}
trap cleanup EXIT

# Start API server
echo -e "${GREEN}[+] Starting API server on :8000...${NC}"
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload &
API_PID=$!

# Wait for API to be ready
sleep 2

# Start MITM proxy
echo -e "${GREEN}[+] Starting MITM proxy on :8443...${NC}"
python -m mitmdump \
    --listen-port 8443 \
    --mode regular \
    --scripts proxy/addons/location_spoof.py \
    --set console_verbosity=info &
PROXY_PID=$!

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${GREEN} All services running!${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "  Web UI:     ${GREEN}http://localhost:8000/${NC}"
echo -e "  API:        ${GREEN}http://localhost:8000/api/status${NC}"
echo -e "  PAC:        ${GREEN}http://localhost:8000/proxy.pac${NC}"
echo -e "  Profile:    ${GREEN}http://localhost:8000/install.mobileconfig${NC}"
echo -e "  Proxy:      ${GREEN}localhost:8443${NC}"
echo ""
echo -e "${YELLOW}  Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for any process to exit
wait
