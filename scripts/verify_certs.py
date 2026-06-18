#!/usr/bin/env python3
"""
Certificate Verification Script for LocSpoof.

Verifies:
1. CA certificate is valid self-signed root CA
2. Server certificates are properly signed by CA
3. Domain names match (SAN)
4. Validity periods are correct
5. Key usage extensions are appropriate
6. Certificate chain validates correctly
"""

import sys
import datetime
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import ExtensionOID
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding


def load_cert(path: str) -> x509.Certificate:
    with open(path, "rb") as f:
        data = f.read()
    if path.endswith(".cer"):
        return x509.load_der_x509_certificate(data)
    return x509.load_pem_x509_certificate(data)


def load_key(path: str):
    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def check(label: str, condition: bool, detail: str = ""):
    status = "[PASS]" if condition else "[FAIL]"
    msg = f"  {status} {label}"
    if detail:
        msg += f"  ({detail})"
    print(msg)
    return condition


def verify_ca(ca_cert: x509.Certificate, ca_key) -> bool:
    print("\n=== Root CA Certificate ===")
    all_ok = True

    # Subject / Issuer
    cn = ca_cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)[0].value
    all_ok &= check("Common Name", True, cn)

    # Self-signed check
    all_ok &= check("Self-signed (subject == issuer)",
                     ca_cert.subject == ca_cert.issuer)

    # CA flag
    bc = ca_cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS)
    all_ok &= check("BasicConstraints: CA=True", bc.value.ca is True)

    # Key Usage
    ku = ca_cert.extensions.get_extension_for_oid(ExtensionOID.KEY_USAGE)
    all_ok &= check("KeyUsage: keyCertSign", ku.value.key_cert_sign)
    all_ok &= check("KeyUsage: crlSign", ku.value.crl_sign)

    # Validity
    now = datetime.datetime.now(datetime.timezone.utc)
    all_ok &= check("Not Before <= Now",
                     ca_cert.not_valid_before_utc <= now,
                     str(ca_cert.not_valid_before_utc.date()))
    all_ok &= check("Not After > Now",
                     ca_cert.not_valid_after_utc > now,
                     f"expires {ca_cert.not_valid_after_utc.date()}")

    # Verify self-signature
    try:
        ca_key.public_key().verify(
            ca_cert.signature,
            ca_cert.tbs_certificate_bytes,
            padding.PKCS1v15(),
            ca_cert.signature_hash_algorithm,
        )
        all_ok &= check("Self-signature valid", True)
    except Exception as e:
        all_ok &= check("Self-signature valid", False, str(e))

    # Key size
    key_size = ca_key.key_size
    all_ok &= check(f"Key size >= 4096 bits", key_size >= 4096, f"{key_size} bits")

    return all_ok


def verify_server_cert(domain: str, cert: x509.Certificate, key, ca_cert: x509.Certificate) -> bool:
    print(f"\n=== Server Certificate: {domain} ===")
    all_ok = True

    # Subject CN
    cn = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)[0].value
    all_ok &= check("Common Name matches domain", cn == domain, cn)

    # SAN
    san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
    dns_names = san.value.get_values_for_type(x509.DNSName)
    all_ok &= check(f"SAN contains {domain}", domain in dns_names, f"DNS: {dns_names}")

    # Not a CA
    bc = cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS)
    all_ok &= check("BasicConstraints: CA=False", bc.value.ca is False)

    # Key Usage
    ku = cert.extensions.get_extension_for_oid(ExtensionOID.KEY_USAGE)
    all_ok &= check("KeyUsage: digitalSignature", ku.value.digital_signature)
    all_ok &= check("KeyUsage: keyEncipherment", ku.value.key_encipherment)

    # Extended Key Usage (Server Auth)
    eku = cert.extensions.get_extension_for_oid(ExtensionOID.EXTENDED_KEY_USAGE)
    server_auth = x509.oid.ExtendedKeyUsageOID.SERVER_AUTH
    all_ok &= check("ExtendedKeyUsage: serverAuth",
                     server_auth in eku.value)

    # Issuer matches CA subject
    all_ok &= check("Issuer matches CA subject",
                     cert.issuer == ca_cert.subject)

    # Validity
    now = datetime.datetime.now(datetime.timezone.utc)
    all_ok &= check("Not Before <= Now",
                     cert.not_valid_before_utc <= now,
                     str(cert.not_valid_before_utc.date()))
    all_ok &= check("Not After > Now",
                     cert.not_valid_after_utc > now,
                     f"expires {cert.not_valid_after_utc.date()}")

    # Verify signature against CA public key
    try:
        ca_cert.public_key().verify(
            cert.signature,
            cert.tbs_certificate_bytes,
            padding.PKCS1v15(),
            cert.signature_hash_algorithm,
        )
        all_ok &= check("CA signature valid (chain of trust)", True)
    except Exception as e:
        all_ok &= check("CA signature valid", False, str(e))

    # Key size
    key_size = key.key_size
    all_ok &= check(f"Key size >= 2048 bits", key_size >= 2048, f"{key_size} bits")

    # Key matches certificate
    cert_pub = cert.public_key()
    key_pub = key.public_key()
    all_ok &= check("Private key matches certificate",
                     cert_pub.public_numbers() == key_pub.public_numbers())

    return all_ok


def verify_der_cert(ca_cert: x509.Certificate):
    """Verify the DER-encoded .cer file matches the PEM CA cert."""
    print("\n=== DER Certificate (ca.cer) ===")
    der_cert = load_cert("certs/ca.cer")
    ok = check("DER cert matches PEM cert",
               der_cert.public_bytes(serialization.Encoding.DER) ==
               ca_cert.public_bytes(serialization.Encoding.DER))
    return ok


def main():
    certs_dir = Path("certs")
    if not certs_dir.exists():
        print("[ERROR] certs/ directory not found. Run generate_ca.py first.")
        sys.exit(1)

    print("=" * 55)
    print("  LocSpoof Certificate Verification")
    print("=" * 55)

    # Load CA
    ca_cert = load_cert("certs/ca.crt")
    ca_key = load_key("certs/ca.key")

    total_ok = True
    total_ok &= verify_ca(ca_cert, ca_key)

    # Verify DER
    total_ok &= verify_der_cert(ca_cert)

    # Verify server certs
    domains = ["gs-loc.apple.com", "gs-loc-cn.apple.com"]
    for domain in domains:
        safe = domain.replace(".", "_")
        cert = load_cert(f"certs/{safe}.crt")
        key = load_key(f"certs/{safe}.key")
        total_ok &= verify_server_cert(domain, cert, key, ca_cert)

    # Summary
    print("\n" + "=" * 55)
    if total_ok:
        print("  ALL CHECKS PASSED")
    else:
        print("  SOME CHECKS FAILED - review above")
    print("=" * 55)

    sys.exit(0 if total_ok else 1)


if __name__ == "__main__":
    main()
