#!/usr/bin/env python3
"""
CA Certificate Generator for iOS Location Spoofing Service.

Generates:
1. Root CA certificate (installed on iOS device via .mobileconfig)
2. Server certificates for intercepted domains (used by MITM proxy)
"""

import os
import sys
import datetime
import argparse
from pathlib import Path

import ipaddress

from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def generate_ca_key_and_cert(
    ca_cn: str = "LocSpoof Root CA",
    ca_org: str = "LocSpoof",
    validity_days: int = 3650,
    key_size: int = 4096,
    output_dir: str = "./certs",
) -> tuple:
    """Generate a self-signed Root CA certificate and private key."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"[*] Generating {key_size}-bit RSA key for Root CA...")
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, ca_cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, ca_org),
    ])

    now = datetime.datetime.now(datetime.timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=validity_days))
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    # Save CA private key
    ca_key_path = output_path / "ca.key"
    with open(ca_key_path, "wb") as f:
        f.write(ca_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    print(f"[+] CA private key saved to: {ca_key_path}")

    # Save CA certificate
    ca_cert_path = output_path / "ca.crt"
    with open(ca_cert_path, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
    print(f"[+] CA certificate saved to: {ca_cert_path}")

    # Also save in DER format (.cer) for iOS .mobileconfig
    ca_cer_path = output_path / "ca.cer"
    with open(ca_cer_path, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.DER))
    print(f"[+] CA certificate (DER/.cer) saved to: {ca_cer_path}")

    return ca_key, ca_cert


def generate_server_cert(
    domain: str,
    ca_key,
    ca_cert,
    key_size: int = 2048,
    validity_days: int = 825,
    output_dir: str = "./certs",
    ip_san: str = None,
) -> tuple:
    """
    Generate a TLS server certificate for a given domain, signed by the CA.
    This is the 'forged' certificate used by the MITM proxy.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"[*] Generating {key_size}-bit RSA key for domain: {domain}")
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)

    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, domain),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Apple Inc."),
    ])

    # Build SAN list: always include DNS name, optionally add IP
    san_names = [x509.DNSName(domain)]
    if ip_san:
        try:
            san_names.append(x509.IPAddress(ipaddress.ip_address(ip_san)))
            print(f"    Adding IP SAN: {ip_san}")
        except ValueError:
            print(f"    [!] Invalid IP for SAN: {ip_san}, skipping")

    now = datetime.datetime.now(datetime.timezone.utc)
    cert_builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=validity_days))
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.SubjectAlternativeName(san_names),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([
                ExtendedKeyUsageOID.SERVER_AUTH,
            ]),
            critical=False,
        )
    )

    server_cert = cert_builder.sign(ca_key, hashes.SHA256())

    # Save server key
    safe_name = domain.replace(".", "_")
    key_path = output_path / f"{safe_name}.key"
    with open(key_path, "wb") as f:
        f.write(server_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    print(f"[+] Server key saved to: {key_path}")

    # Save server certificate (PEM)
    cert_path = output_path / f"{safe_name}.crt"
    with open(cert_path, "wb") as f:
        f.write(server_cert.public_bytes(serialization.Encoding.PEM))
    print(f"[+] Server certificate saved to: {cert_path}")

    # Save combined PEM (cert + key) for mitmproxy
    combined_path = output_path / f"{safe_name}.pem"
    with open(combined_path, "wb") as f:
        f.write(server_cert.public_bytes(serialization.Encoding.PEM))
        f.write(server_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    print(f"[+] Combined PEM saved to: {combined_path}")

    return server_key, server_cert


def generate_all_certs(config_path: str = "./config/config.yaml"):
    """Generate CA + all server certificates based on config."""
    import yaml

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    certs_dir = "./certs"
    ca_cfg = config.get("certs", {})

    # Generate CA
    ca_key, ca_cert = generate_ca_key_and_cert(
        ca_cn=ca_cfg.get("ca_cn", "LocSpoof Root CA"),
        ca_org=ca_cfg.get("ca_org", "LocSpoof"),
        validity_days=ca_cfg.get("ca_validity_days", 3650),
        output_dir=certs_dir,
    )

    # Generate server certs for each forge domain
    forge_domains = ca_cfg.get("forge_domains", [])
    for domain in forge_domains:
        generate_server_cert(
            domain=domain,
            ca_key=ca_key,
            ca_cert=ca_cert,
            output_dir=certs_dir,
        )

    # LAN mode: generate a server cert with IP SAN for the LAN IP
    lan_ip = ca_cfg.get("lan_ip_san")
    if lan_ip and lan_ip != "LAN_IP":
        print(f"\n[*] Generating LAN server cert with IP SAN: {lan_ip}")
        generate_server_cert(
            domain=lan_ip,
            ca_key=ca_key,
            ca_cert=ca_cert,
            output_dir=certs_dir,
            ip_san=lan_ip,
        )

    print(f"\n[OK] All certificates generated in {certs_dir}/")
    print("[!] Keep ca.key secure - never distribute it!")
    print(f"[!] Install ca.cer on iOS devices via .mobileconfig profile")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CA Certificate Generator")
    parser.add_argument(
        "--config", default="./config/config.yaml",
        help="Path to config.yaml"
    )
    parser.add_argument(
        "--domain",
        help="Generate cert for a single domain (skip config)"
    )
    parser.add_argument(
        "--ip-san",
        help="Add an IP address to the SAN of the generated cert"
    )
    parser.add_argument(
        "--certs-dir", default="./certs",
        help="Output directory for certificates"
    )
    args = parser.parse_args()

    if args.domain:
        # Quick mode: load existing CA and sign one domain
        from cryptography.x509 import load_pem_x509_certificate
        certs_dir = args.certs_dir
        ca_key_path = Path(certs_dir) / "ca.key"
        ca_cert_path = Path(certs_dir) / "ca.crt"

        if not ca_key_path.exists() or not ca_cert_path.exists():
            print("[!] CA not found. Run without --domain first to generate CA.")
            sys.exit(1)

        with open(ca_key_path, "rb") as f:
            ca_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(ca_cert_path, "rb") as f:
            ca_cert = load_pem_x509_certificate(f.read())

        generate_server_cert(
            domain=args.domain,
            ca_key=ca_key,
            ca_cert=ca_cert,
            output_dir=certs_dir,
            ip_san=args.ip_san,
        )
    else:
        generate_all_certs(config_path=args.config)
