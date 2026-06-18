#!/bin/bash
# Test the MITM proxy by sending a request through it
echo "=== Test 1: curl through proxy ==="
curl -sk --proxy http://localhost:8443 https://gs-loc.apple.com/clls/wloc -X POST -d "test" 2>&1 | xxd | head -5

echo ""
echo "=== Test 2: GET through proxy ==="
curl -sk --proxy http://localhost:8443 https://gs-loc.apple.com/clls/wloc 2>&1 | xxd | head -5

echo ""
echo "=== Test 3: Check proxy logs ==="
sleep 1
docker logs --since 30s locspoof-proxy 2>&1
