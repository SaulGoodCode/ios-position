#!/bin/bash
# Debug the 502 issue
echo "=== API listening ==="
docker exec locspoof-api sh -c "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || cat /proc/net/tcp"

echo ""
echo "=== Direct TCP from proxy ==="
docker exec locspoof-proxy python -c "
import socket, http.client
# Raw TCP test
s = socket.socket()
s.settimeout(5)
s.connect(('172.18.0.2', 8000))
s.sendall(b'GET /health HTTP/1.0\r\nHost: api\r\n\r\n')
data = b''
while True:
    chunk = s.recv(4096)
    if not chunk: break
    data += chunk
s.close()
print('Raw response:')
print(data.decode('utf-8', errors='replace'))
"

echo ""
echo "=== From VM host ==="
curl -v http://172.18.0.2:8000/health 2>&1 | grep -E '<|>' | head -10
