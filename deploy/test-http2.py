import httpx, socket

# Test 1: httpx with different Host headers
print("=== Test 1: httpx with explicit Host ===")
try:
    r = httpx.get("http://api:8000/health", headers={"Host": "api:8000"}, timeout=5)
    print(f"With Host header: {r.status_code} {r.text}")
except Exception as e:
    print(f"FAIL: {e}")

print("=== Test 2: httpx to direct IP ===")
try:
    r = httpx.get("http://172.18.0.2:8000/health", timeout=5)
    print(f"Direct IP: {r.status_code} {r.text}")
except Exception as e:
    print(f"FAIL: {e}")

print("=== Test 3: httpx with full headers ===")
try:
    r = httpx.get("http://api:8000/health", headers={
        "Accept": "*/*",
        "User-Agent": "curl/8.0",
    }, timeout=5, follow_redirects=False)
    print(f"Full headers: {r.status_code} {r.text}")
    print(f"Response headers: {dict(r.headers)}")
except Exception as e:
    print(f"FAIL: {e}")

print("=== Test 4: Check what httpx sends ===")
import socket
s = socket.socket()
s.settimeout(5)
s.connect(("api", 8000))
# Mimic what httpx sends
req = b"GET /health HTTP/1.1\r\nHost: api\r\nAccept: */*\r\nAccept-Encoding: gzip, deflate\r\nConnection: keep-alive\r\n\r\n"
s.sendall(req)
data = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    data += chunk
s.close()
print(f"Mimic httpx:\n{data.decode('utf-8', errors='replace')[:500]}")
