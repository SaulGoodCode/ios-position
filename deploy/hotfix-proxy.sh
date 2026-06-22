#!/bin/bash
# Hot-fix: restart MITM proxy inside the stuck container
set -e

CERTS_DIR="/app/certs"
API_HOST="api"
API_PORT="8000"

CERT_ARGS=""
for domain in gs-loc.apple.com gs-loc-cn.apple.com; do
    safe=$(echo "$domain" | tr '.' '_')
    pem="$CERTS_DIR/${safe}.pem"
    if [ -f "$pem" ]; then
        CERT_ARGS="$CERT_ARGS --cert ${domain}=${pem}"
        echo "[Proxy] Loaded cert for: $domain"
    else
        echo "[Proxy] WARNING: No cert for $domain"
    fi
done

export LOCSPOOF_API_URL="http://${API_HOST}:${API_PORT}/api/location"

echo "[Proxy] Starting MITM proxy on :8443..."
exec mitmdump \
    --listen-port 8443 \
    --mode regular \
    --scripts /app/proxy/addons/location_spoof.py \
    --set confdir=/app/data/mitmproxy \
    --set console_verbosity=info \
    $CERT_ARGS
