"""
Run LocSpoof services in development mode (Windows compatible).

Usage:
    python run.py          # Start API server
    python run.py proxy    # Start MITM proxy
    python run.py all      # Start both (requires subprocess management)
"""

import sys
import subprocess
from pathlib import Path


def start_api():
    """Start the FastAPI backend server."""
    print("=" * 50)
    print("  Starting LocSpoof API Server")
    print("=" * 50)
    print("  Web UI:  http://localhost:8000/")
    print("  API:     http://localhost:8000/api/status")
    print("  Profile: http://localhost:8000/install.mobileconfig")
    print("=" * 50)

    subprocess.run([
        sys.executable, "-m", "uvicorn",
        "backend.main:app",
        "--host", "0.0.0.0",
        "--port", "8000",
        "--reload",
    ])


def start_proxy():
    """Start the MITM proxy."""
    print("=" * 50)
    print("  Starting LocSpoof MITM Proxy")
    print("=" * 50)
    print("  Proxy:   localhost:8443")
    print("=" * 50)

    addon_path = str(Path("proxy/addons/location_spoof.py").absolute())

    subprocess.run([
        sys.executable, "-m", "mitmdump",
        "--listen-port", "8443",
        "--mode", "regular",
        "--scripts", addon_path,
        "--set", "console_verbosity=info",
    ])


def generate_certs():
    """Generate CA certificates if they don't exist."""
    certs_dir = Path("certs")
    if not (certs_dir / "ca.crt").exists():
        print("[*] Generating certificates...")
        subprocess.run([sys.executable, "scripts/generate_ca.py"])
    else:
        print("[+] Certificates already exist.")


if __name__ == "__main__":
    # Ensure data dir exists
    Path("data").mkdir(exist_ok=True)

    if len(sys.argv) < 2:
        # Default: generate certs and start API
        generate_certs()
        start_api()
    elif sys.argv[1] == "proxy":
        start_proxy()
    elif sys.argv[1] == "api":
        generate_certs()
        start_api()
    elif sys.argv[1] == "certs":
        generate_certs()
    elif sys.argv[1] == "all":
        generate_certs()
        # Start both in separate processes
        import threading
        proxy_thread = threading.Thread(target=start_proxy, daemon=True)
        proxy_thread.start()
        start_api()
    else:
        print(__doc__)
