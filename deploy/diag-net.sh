#!/bin/bash
# Quick network diagnostic
echo "=== Container Networks ==="
docker inspect locspoof-api -f '{{.Name}}: {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
docker inspect locspoof-proxy -f '{{.Name}}: {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'

echo ""
echo "=== Test from proxy ==="
docker exec locspoof-proxy python -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('http://api:8000/health', timeout=5)
    print(f'OK: {r.status} {r.read().decode()}')
except Exception as e:
    print(f'FAIL: {e}')
try:
    r = urllib.request.urlopen('http://172.18.0.2:8000/health', timeout=5)
    print(f'Direct IP OK: {r.status} {r.read().decode()}')
except Exception as e:
    print(f'Direct IP FAIL: {e}')
"

echo ""
echo "=== Docker network details ==="
docker network inspect deploy_default -f '{{range .Containers}}{{.Name}}: {{.IPv4Address}}  {{end}}'
