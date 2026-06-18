"""
Certificate management service.
Handles loading CA certs and generating on-the-fly TLS certs for MITM.
"""

import os
from pathlib import Path
from typing import Optional
from functools import lru_cache

from cryptography import x509
from cryptography.hazmat.primitives import serialization


class CertManager:
    """Manages CA certificates and forged server certificates."""

    def __init__(self, certs_dir: str = "./certs"):
        self.certs_dir = Path(certs_dir)
        self._ca_key = None
        self._ca_cert = None

    @property
    def ca_key(self):
        if self._ca_key is None:
            self._load_ca()
        return self._ca_key

    @property
    def ca_cert(self):
        if self._ca_cert is None:
            self._load_ca()
        return self._ca_cert

    def _load_ca(self):
        ca_key_path = self.certs_dir / "ca.key"
        ca_cert_path = self.certs_dir / "ca.crt"

        if not ca_key_path.exists() or not ca_cert_path.exists():
            raise FileNotFoundError(
                f"CA certificates not found in {self.certs_dir}. "
                "Run: python scripts/generate_ca.py"
            )

        with open(ca_key_path, "rb") as f:
            self._ca_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(ca_cert_path, "rb") as f:
            self._ca_cert = x509.load_pem_x509_certificate(f.read())

    def get_ca_cert_der(self) -> bytes:
        """Return the CA certificate in DER format (for .mobileconfig embedding)."""
        return self.ca_cert.public_bytes(serialization.Encoding.DER)

    def get_ca_cert_pem(self) -> bytes:
        """Return the CA certificate in PEM format."""
        return self.ca_cert.public_bytes(serialization.Encoding.PEM)

    def get_server_cert_path(self, domain: str) -> Optional[Path]:
        """Get the path to a pre-generated server certificate for a domain."""
        safe_name = domain.replace(".", "_")
        cert_path = self.certs_dir / f"{safe_name}.crt"
        key_path = self.certs_dir / f"{safe_name}.key"

        if cert_path.exists() and key_path.exists():
            return cert_path
        return None

    def get_server_key_path(self, domain: str) -> Optional[Path]:
        """Get the path to a pre-generated server key for a domain."""
        safe_name = domain.replace(".", "_")
        key_path = self.certs_dir / f"{safe_name}.key"

        if key_path.exists():
            return key_path
        return None

    def get_combined_pem_path(self, domain: str) -> Optional[Path]:
        """Get the path to the combined PEM (cert + key) for a domain."""
        safe_name = domain.replace(".", "_")
        combined_path = self.certs_dir / f"{safe_name}.pem"

        if combined_path.exists():
            return combined_path
        return None

    def verify_certs_exist(self) -> bool:
        """Check that all required certificates are present."""
        required = ["ca.key", "ca.crt", "ca.cer"]
        for name in required:
            if not (self.certs_dir / name).exists():
                return False
        return True


# Global instance
cert_manager = CertManager()
