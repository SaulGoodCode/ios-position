#!/usr/bin/env python3
"""
MITM Proxy launcher for iOS Location Spoofing.

Launches mitmproxy with the location spoofing addon, configured to:
1. Use pre-generated server certificates for intercepted domains
2. Listen on the configured port (default 8443)
3. Forward non-intercepted traffic normally

Usage:
    python -m proxy.mitm_proxy                          # Use defaults
    python -m proxy.mitm_proxy --port 8443               # Custom port
    python -m proxy.mitm_proxy --certs-dir ./certs        # Custom certs dir
"""

import os
import sys
import argparse
import subprocess
from pathlib import Path


def find_cert_for_domain(certs_dir: str, domain: str) -> tuple:
    """Find the cert and key files for a given domain."""
    safe_name = domain.replace(".", "_")
    cert_path = Path(certs_dir) / f"{safe_name}.crt"
    key_path = Path(certs_dir) / f"{safe_name}.key"

    if cert_path.exists() and key_path.exists():
        return str(cert_path), str(key_path)
    return None, None


def build_mitmproxy_args(port: int, certs_dir: str) -> list:
    """Build the command-line arguments for mitmproxy."""
    addon_path = Path(__file__).parent / "addons" / "location_spoof.py"

    # Base arguments
    args = [
        "mitmdump",
        "--listen-port", str(port),
        "--mode", "regular",
        "--scripts", str(addon_path),
        "--set", f"confdir={Path(certs_dir).absolute() / 'mitmproxy'}",
        # Disable the web UI for performance
        "--set", "console_verbosity=info",
    ]

    # Add certificate specs for each intercepted domain
    domains = ["gs-loc.apple.com", "gs-loc-cn.apple.com"]
    for domain in domains:
        cert_path, key_path = find_cert_for_domain(certs_dir, domain)
        if cert_path and key_path:
            # mitmproxy --cert format: domain=path_to_pem
            combined_pem = Path(certs_dir) / f"{domain.replace('.', '_')}.pem"
            if combined_pem.exists():
                args.extend(["--cert", f"{domain}={combined_pem}"])
                print(f"  [+] Loaded cert for: {domain}")
            else:
                print(f"  [!] Combined PEM not found for {domain}, using default")
        else:
            print(f"  [!] No cert found for {domain}, mitmproxy will auto-generate")

    return args


def main():
    parser = argparse.ArgumentParser(description="LocSpoof MITM Proxy")
    parser.add_argument("--port", type=int, default=8443, help="Listen port")
    parser.add_argument("--certs-dir", default="./certs", help="Certificates directory")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    print("=" * 50)
    print(" LocSpoof MITM Proxy")
    print("=" * 50)
    print(f"  Listen port:  {args.port}")
    print(f"  Certs dir:    {args.certs_dir}")
    print(f"  Loading certificates...")

    proxy_args = build_mitmproxy_args(args.port, args.certs_dir)

    print(f"\n  Starting proxy...")
    print(f"  Command: {' '.join(proxy_args)}")
    print("=" * 50)

    # Execute mitmproxy
    try:
        subprocess.run(proxy_args, check=True)
    except KeyboardInterrupt:
        print("\n[*] Proxy stopped.")
    except FileNotFoundError:
        print("\n[!] mitmproxy not found. Install it:")
        print("    pip install mitmproxy")
        sys.exit(1)


if __name__ == "__main__":
    main()
