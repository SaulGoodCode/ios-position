#!/bin/bash
# MITM Proxy container entrypoint

set -e

CERTS_DIR="${CERTS_DIR:-/app/certs}"
API_HOST="${API_HOST:-api}"
API_PORT="${API_PORT:-8000}"

echo "[Proxy] Waiting for API server..."
if command -v curl &> /dev/null; then
    until curl -sf "http://${API_HOST}:${API_PORT}/health" > /dev/null 2>&1; do
        sleep 1
    done
else
    # Fallback: use Python to check health
    until python -c "import urllib.request; urllib.request.urlopen('http://${API_HOST}:${API_PORT}/health')" 2>/dev/null; do
        sleep 1
    done
fi
echo "[Proxy] API server is ready."

# Build cert args for mitmdump
CERT_ARGS=""
for domain in gs-loc.apple.com gs-loc-cn.apple.com; do
    safe=$(echo "$domain" | tr '.' '_')
    pem="$CERTS_DIR/${safe}.pem"
    if [ -f "$pem" ]; then
        CERT_ARGS="$CERT_ARGS --certs ${domain}=${pem}"
        echo "[Proxy] Loaded cert for: $domain"
    fi
done

# Override the API URL in the addon
export LOCSPOOF_API_URL="http://${API_HOST}:${API_PORT}/api/location"

echo "[Proxy] Starting MITM proxy on :8443 (transparent mode)..."
export PYTHONPATH=/app:$PYTHONPATH

# Create mitmproxy user (UID 1000) for iptables owner exclusion
# This prevents the proxy's own outbound HTTPS connections from being DNAT'd
useradd -r -u 1000 -s /bin/false mitmproxy 2>/dev/null || true
chown -R mitmproxy:mitmproxy /app/data 2>/dev/null || true

# Start dummy mitmdump on port 8444 to handle the proxy's own upstream connections
su -s /bin/sh mitmproxy -c "mitmdump --listen-port 8444 --mode regular --set confdir=/tmp/dummy-mitm --set console_verbosity=error" &
echo "[Proxy] Dummy proxy started on :8444"

echo "[Proxy] Running mitmdump as UID 1000..."
exec su -s /bin/sh mitmproxy -c "PYTHONPATH=/app LOCSPOOF_API_URL=$LOCSPOOF_API_URL mitmdump \
    --listen-port 8443 \
    --mode transparent \
    --scripts /app/proxy/addons/location_spoof.py \
    --set confdir=/app/data/mitmproxy \
    --set console_verbosity=info \
    --set connection_strategy=lazy \
    $CERT_ARGS"
