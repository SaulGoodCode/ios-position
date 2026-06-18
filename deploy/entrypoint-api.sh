#!/bin/bash
# API container entrypoint
# Generates certificates if they don't exist, then starts API

set -e

CERTS_DIR="${CERTS_DIR:-/app/certs}"

# Generate certs if CA doesn't exist
if [ ! -f "$CERTS_DIR/ca.crt" ]; then
    echo "[API] First run - generating certificates..."
    python scripts/generate_ca.py --config /app/config/config.yaml
    echo "[API] Certificates generated."
else
    echo "[API] Certificates found."
fi

# Create data dir
mkdir -p /app/data

echo "[API] Starting FastAPI server on :8000..."
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000
