import socket, sys

# Test DNS resolution
try:
    addrs = socket.getaddrinfo("api", 8000)
    print(f"DNS resolved: api -> {addrs[0][4]}")
except Exception as e:
    print(f"DNS FAILED: {e}")
    sys.exit(1)

# Test HTTP
import urllib.request
try:
    resp = urllib.request.urlopen("http://api:8000/health", timeout=5)
    print(f"HTTP OK: {resp.status} {resp.read().decode()}")
except Exception as e:
    print(f"HTTP FAILED: {e}")
    sys.exit(1)
