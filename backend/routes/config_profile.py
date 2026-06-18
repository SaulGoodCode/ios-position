"""
iOS Configuration Profile (.mobileconfig) generator.

Generates a signed configuration profile that:
1. Installs the custom Root CA certificate
2. Configures IKEv2 VPN with DNS split-tunneling
3. Sets up PAC proxy for location service interception
"""

import uuid
import base64
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import Response

from backend.config import settings, yaml_config
from backend.services.cert_manager import cert_manager

router = APIRouter(tags=["config_profile"])


def generate_mobileconfig(
    vpn_host: str,
    api_host: str,
    vpn_username: str,
    vpn_password: str,
    ca_cert_der: bytes,
    intercept_domains: list,
    proxy_host: str,
    proxy_port: int = 8443,
    display_name: str = "LocSpoof",
    use_https: bool = True,
    dns_servers: list = None,
) -> bytes:
    """
    Generate a .mobileconfig XML plist profile.
    """
    profile_uuid = str(uuid.uuid4()).upper()
    vpn_uuid = str(uuid.uuid4()).upper()
    cert_uuid = str(uuid.uuid4()).upper()

    ca_cert_b64 = base64.b64encode(ca_cert_der).decode("ascii")
    # Split into 76-char lines for readability
    ca_cert_b64_lines = "\n".join(
        ca_cert_b64[i:i + 76] for i in range(0, len(ca_cert_b64), 76)
    )

    # Build the supplemental match domains XML array
    domain_entries = "\n".join(
        f"\t\t\t\t\t<string>{d}</string>" for d in intercept_domains
    )

    # Build DNS server addresses for the VPN DNS payload
    # This tells iOS to route DNS queries for matched domains through the VPN
    if dns_servers is None:
        dns_servers = ["10.10.10.1"]
    dns_server_entries = "\n".join(
        f"\t\t\t\t\t<string>{s}</string>" for s in dns_servers
    )

    # PAC URL scheme: HTTPS for domain mode, HTTP for LAN mode
    pac_scheme = "https" if use_https else "http"

    mobileconfig_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadCertificateFileName</key>
\t\t\t<string>ca.cert.cer</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>
\t\t\t{ca_cert_b64_lines}
\t\t\t</data>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>Install Root CA certificate</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>{display_name} Root CA</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.apple.security.root.{cert_uuid}</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>{cert_uuid}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>DNS</key>
\t\t\t<dict>
\t\t\t\t<key>ServerAddresses</key>
\t\t\t\t<array>
{dns_server_entries}
\t\t\t\t</array>
\t\t\t\t<key>SearchDomains</key>
\t\t\t\t<array/>
\t\t\t\t<key>SupplementalMatchDomains</key>
\t\t\t\t<array>
{domain_entries}
\t\t\t\t</array>
\t\t\t\t<key>SupplementalMatchDomainsNoSearch</key>
\t\t\t\t<integer>0</integer>
\t\t\t</dict>
\t\t\t<key>IKEv2</key>
\t\t\t<dict>
\t\t\t\t<key>AuthName</key>
\t\t\t\t<string>{vpn_username}</string>
\t\t\t\t<key>AuthPassword</key>
\t\t\t\t<string>{vpn_password}</string>
\t\t\t\t<key>AuthenticationMethod</key>
\t\t\t\t<string>None</string>
\t\t\t\t<key>ChildSecurityAssociationParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>DiffieHellmanGroup</key>
\t\t\t\t\t<integer>19</integer>
\t\t\t\t\t<key>EncryptionAlgorithm</key>
\t\t\t\t\t<string>AES-256-GCM</string>
\t\t\t\t\t<key>IntegrityAlgorithm</key>
\t\t\t\t\t<string>SHA2-256</string>
\t\t\t\t\t<key>LifeTimeInMinutes</key>
\t\t\t\t\t<integer>1440</integer>
\t\t\t\t</dict>
\t\t\t\t<key>DeadPeerDetectionRate</key>
\t\t\t\t<string>Medium</string>
\t\t\t\t<key>DisableMOBIKE</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>DisableRedirect</key>
\t\t\t\t<true/>
\t\t\t\t<key>EnableCertificateRevocationCheck</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>EnableFallback</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>EnablePFS</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>ExtendedAuthEnabled</key>
\t\t\t\t<true/>
\t\t\t\t<key>IKESecurityAssociationParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>DiffieHellmanGroup</key>
\t\t\t\t\t<integer>19</integer>
\t\t\t\t\t<key>EncryptionAlgorithm</key>
\t\t\t\t\t<string>AES-256-GCM</string>
\t\t\t\t\t<key>IntegrityAlgorithm</key>
\t\t\t\t\t<string>SHA2-256</string>
\t\t\t\t\t<key>LifeTimeInMinutes</key>
\t\t\t\t\t<integer>1440</integer>
\t\t\t\t</dict>
\t\t\t\t<key>LocalIdentifier</key>
\t\t\t\t<string>vpnclient</string>
\t\t\t\t<key>RemoteAddress</key>
\t\t\t\t<string>{vpn_host}</string>
\t\t\t\t<key>RemoteIdentifier</key>
\t\t\t\t<string>{vpn_host}</string>
\t\t\t\t<key>UseConfigurationAttributeInternalIPSubnet</key>
\t\t\t\t<integer>0</integer>
\t\t\t</dict>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>Configure VPN settings</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>VPN</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.apple.vpn.managed.{vpn_uuid}</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.vpn.managed</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>{vpn_uuid}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t\t<key>Proxies</key>
\t\t\t<dict>
\t\t\t\t<key>HTTPEnable</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>HTTPSEnable</key>
\t\t\t\t<integer>0</integer>
\t\t\t\t<key>ProxyAutoConfigEnable</key>
\t\t\t\t<true/>
\t\t\t\t<key>ProxyAutoConfigURLString</key>
\t\t\t\t<string>{pac_scheme}://{api_host}/proxy.pac</string>
\t\t\t</dict>
\t\t\t<key>UserDefinedName</key>
\t\t\t<string>{display_name}</string>
\t\t\t<key>VPNType</key>
\t\t\t<string>IKEv2</string>
\t\t</dict>
\t</array>
\t<key>PayloadDisplayName</key>
\t<string>{display_name}</string>
\t<key>PayloadIdentifier</key>
\t<string>com.locspoof.profile.{profile_uuid}</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>{profile_uuid}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>"""

    return mobileconfig_xml.encode("utf-8")


@router.get("/install.mobileconfig")
async def download_config_profile(
    request: Request,
    username: str = Query(default="user"),
    password: str = Query(default="changeme"),
):
    """
    Download the iOS configuration profile.
    Access this from Safari on the iPhone to trigger profile installation.
    """
    try:
        ca_cert_der = cert_manager.get_ca_cert_der()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))

    server_cfg = yaml_config.get("server", {})

    # Env vars take priority over yaml config (important for Docker)
    import os
    vpn_host = os.environ.get("VPN_HOST") or server_cfg.get("vpn_host") or settings.vpn_host
    api_host = os.environ.get("API_HOST") or server_cfg.get("api_host") or settings.api_host

    # Mode: "lan" uses HTTP for PAC, "domain" uses HTTPS
    # In Docker / LAN mode, always use HTTP since there's no valid TLS cert for LAN IP
    mode = os.environ.get("LAN_MODE") or server_cfg.get("mode", "domain")
    intercept_domains = yaml_config.get("intercept_domains", [
        "gs-loc-cn.apple.com",
        "gs-loc.apple.com",
    ])

    # LAN mode uses HTTP for PAC URL (no valid TLS cert for LAN IP)
    use_https = mode != "lan"

    profile_data = generate_mobileconfig(
        vpn_host=vpn_host,
        api_host=api_host,
        vpn_username=username,
        vpn_password=password,
        ca_cert_der=ca_cert_der,
        intercept_domains=intercept_domains,
        proxy_host=api_host,
        use_https=use_https,
    )

    return Response(
        content=profile_data,
        media_type="application/x-apple-aspen-config",
        headers={
            "Content-Disposition": 'attachment; filename="locspoof.mobileconfig"',
        },
    )
