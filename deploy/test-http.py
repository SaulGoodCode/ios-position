import httpx, urllib.request

print("=== httpx test ===")
try:
    r = httpx.get("http://api:8000/health", timeout=5)
    print(f"httpx: {r.status_code} {r.text}")
except Exception as e:
    print(f"httpx FAIL: {e}")

print("=== urllib test ===")
try:
    r = urllib.request.urlopen("http://api:8000/health", timeout=5)
    print(f"urllib: {r.status} {r.read().decode()}")
except Exception as e:
    print(f"urllib FAIL: {e}")
    import traceback
    traceback.print_exc()

print("=== raw socket test ===")
import socket
s = socket.socket()
s.settimeout(5)
s.connect(("api", 8000))
req = b"GET /health HTTP/1.1\r\nHost: api:8000\r\nConnection: close\r\n\r\n"
s.sendall(req)
data = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    data += chunk
s.close()
print(f"Raw:\n{data.decode('utf-8', errors='replace')[:500]}")
