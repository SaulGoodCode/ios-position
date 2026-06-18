"""
Configuration management for the Location Spoofing backend.
Env vars always take priority over yaml config (important for Docker).
"""

import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import Field


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


class Settings:
    """Simple settings that read from env vars."""

    def __init__(self):
        self.server_domain = _env("SERVER_DOMAIN", "locspoof.local")
        self.vpn_host = _env("VPN_HOST", "vpn.locspoof.local")
        self.api_host = _env("API_HOST", "api.locspoof.local")
        self.vpn_username = _env("VPN_USERNAME", "user@locspoof.local")
        self.vpn_password = _env("VPN_PASSWORD", "changeme")
        self.profile_secret = _env("PROFILE_SECRET", "dev-secret")
        self.config_path = _env("CONFIG_PATH", "./config/config.yaml")
        self.certs_dir = _env("CERTS_DIR", "./certs")
        self.data_dir = _env("DATA_DIR", "./data")


def load_yaml_config(path: str = "./config/config.yaml") -> dict:
    """Load the YAML configuration file."""
    config_file = Path(path)
    if config_file.exists():
        with open(config_file, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


# Global settings instance
settings = Settings()
yaml_config = load_yaml_config(settings.config_path)
