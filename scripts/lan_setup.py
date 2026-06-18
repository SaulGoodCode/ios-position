#!/usr/bin/env python3
"""
LAN Setup Helper for LocSpoof (Two-Machine Architecture).

Configures the project for a LAN setup where:
  - Windows host:  runs API + Web + MITM Proxy
  - VMware Linux:  runs strongSwan IKEv2 VPN server
  - iPhone:        connects via WiFi on the same LAN

Usage:
    python scripts/lan_setup.py                                         # Auto-detect
    python scripts/lan_setup.py --ip 192.168.1.53 --vm-ip 192.168.1.60 # Manual
"""

import os
import sys
import socket
import shutil
import argparse
import subprocess
from pathlib import Path

try:
    import yaml
except ImportError:
    print("[!] pyyaml not installed. Run: pip install pyyaml")
    sys.exit(1)


def detect_lan_ip() -> str:
    """Detect the primary LAN IP of this machine."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        # Skip VPN/proxy IPs (198.18.x.x)
        if not ip.startswith("198.18."):
            return ip
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        ips = socket.getaddrinfo(hostname, None, socket.AF_INET)
        for info in ips:
            ip = info[4][0]
            if ip.startswith("127.") or ip.startswith("198.18."):
                continue
            # Prefer 192.168.x.x (typical LAN)
            if ip.startswith("192.168."):
                return ip
    except Exception:
        pass

    return ""


def validate_ip(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        return all(0 <= int(p) <= 255 for p in parts)
    except ValueError:
        return False


def setup_lan_config(lan_ip: str, vm_ip: str, project_dir: Path):
    """Generate config.yaml from LAN template."""
    template_path = project_dir / "config" / "config.lan.yaml"
    config_path = project_dir / "config" / "config.yaml"

    if not template_path.exists():
        print(f"[!] Template not found: {template_path}")
        sys.exit(1)

    # Backup
    if config_path.exists():
        backup_path = project_dir / "config" / "config.yaml.bak"
        shutil.copy2(config_path, backup_path)
        print(f"[+] Backed up existing config -> {backup_path.name}")

    # Replace placeholders
    content = template_path.read_text(encoding="utf-8")
    content = content.replace("LAN_IP", lan_ip)
    content = content.replace("VM_IP", vm_ip)

    config_path.write_text(content, encoding="utf-8")
    print(f"[+] config.yaml: Windows={lan_ip}, VMware VM={vm_ip}")


def setup_lan_certs(lan_ip: str, project_dir: Path):
    """Generate certificates including LAN IP SAN."""
    config_path = project_dir / "config" / "config.yaml"
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    config["certs"]["lan_ip_san"] = lan_ip

    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

    print("[*] Generating certificates...")
    result = subprocess.run(
        [sys.executable, str(project_dir / "scripts" / "generate_ca.py")],
        cwd=str(project_dir),
    )
    if result.returncode != 0:
        print("[!] Certificate generation failed!")
        sys.exit(1)


def print_instructions(lan_ip: str, vm_ip: str):
    """Print the full deployment guide."""
    print()
    print("=" * 60)
    print("  LAN Setup Complete - Deployment Guide")
    print("=" * 60)
    print()
    print(f"  Windows Host:  {lan_ip}  (API + Proxy + Web)")
    print(f"  VMware Linux:  {vm_ip}  (VPN Server)")
    print()

    print("  === STEP 1: Start VPN Server (VMware Linux) ===")
    print()
    print(f"  Copy the project to the VM, then inside vpn/docker/:")
    print(f"    bash setup.sh {vm_ip}")
    print()
    print(f"  Or manually:")
    print(f"    cd vpn/docker")
    print(f"    VPN_HOST={vm_ip} docker compose up -d")
    print()

    print("  === STEP 2: Start API + Proxy (Windows) ===")
    print()
    print(f"  Terminal 1:")
    print(f"    pip install fastapi uvicorn pyyaml cryptography -q")
    print(f"    python run.py")
    print()
    print(f"  Terminal 2:")
    print(f"    pip install mitmproxy httpx -q")
    print(f"    python run.py proxy")
    print()

    print("  === STEP 3: Configure iPhone ===")
    print()
    print(f"  a) Safari -> http://{lan_ip}:8000/install.mobileconfig?username=user&password=changeme")
    print(f"  b) Settings -> tap profile -> Install")
    print(f"  c) Settings -> General -> About -> Certificate Trust")
    print(f"     -> Enable 'LocSpoof Root CA'")
    print(f"  d) Settings -> VPN -> Toggle ON")
    print(f"  e) http://{lan_ip}:8000/ -> Pick location -> Apply")
    print()

    print("=" * 60)
    print("  NOTE: The certs/ folder must be shared between Windows")
    print("  and the VM. The VPN Docker container uses certs from a")
    print("  mounted volume. If you use VMware shared folders, set")
    print(f"  CERTS_DIR=<shared_path>/certs in the VM's .env file.")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="LocSpoof LAN Setup (Windows + VMware)")
    parser.add_argument("--ip", help="Windows host LAN IP (auto-detect if omitted)")
    parser.add_argument("--vm-ip", help="VMware Linux VM LAN IP (required for VPN)")
    parser.add_argument(
        "--project-dir",
        default=str(Path(__file__).parent.parent),
        help="Project root directory"
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir)

    print("=" * 60)
    print("  LocSpoof LAN Setup (Windows + VMware)")
    print("=" * 60)
    print()

    # Detect Windows host IP
    if args.ip:
        lan_ip = args.ip
    else:
        lan_ip = detect_lan_ip()

    if not lan_ip or not validate_ip(lan_ip):
        print("[!] Could not detect Windows LAN IP.")
        print("    python scripts/lan_setup.py --ip YOUR_WINDOWS_IP --vm-ip YOUR_VM_IP")
        sys.exit(1)

    print(f"[*] Windows Host IP: {lan_ip}")

    # VM IP
    if args.vm_ip:
        vm_ip = args.vm_ip
    else:
        vm_ip = input("[?] Enter VMware Linux VM LAN IP: ").strip()

    if not vm_ip or not validate_ip(vm_ip):
        print("[!] Invalid VM IP.")
        sys.exit(1)

    print(f"[*] VMware VM IP:    {vm_ip}")
    print()

    # Generate config
    setup_lan_config(lan_ip, vm_ip, project_dir)

    # Generate certs
    setup_lan_certs(lan_ip, project_dir)

    # Print instructions
    print_instructions(lan_ip, vm_ip)


if __name__ == "__main__":
    main()
