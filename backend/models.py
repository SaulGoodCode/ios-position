"""
Data models for the Location Spoofing service.
"""

import time
from typing import Optional
from pydantic import BaseModel, Field


class LocationPoint(BaseModel):
    """A spoofed location."""
    lat: float = Field(..., description="Latitude", ge=-90, le=90)
    lng: float = Field(..., description="Longitude", ge=-180, le=180)
    label: str = Field(default="", description="Human-readable location name")
    altitude: float = Field(default=0.0, description="Altitude in meters")
    horizontal_accuracy: float = Field(default=65.0, description="Horizontal accuracy in meters")
    vertical_accuracy: float = Field(default=10.0, description="Vertical accuracy in meters")
    timestamp: float = Field(default_factory=time.time)


class DeviceConfig(BaseModel):
    """Per-device configuration."""
    device_id: str
    device_name: str = ""
    location: Optional[LocationPoint] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class UserProfile(BaseModel):
    """User profile for config profile generation."""
    username: str
    password: str
    device_id: str = ""
    display_name: str = ""


class VPNConfig(BaseModel):
    """VPN connection settings."""
    server: str
    username: str
    password: str
    vpn_type: str = "IKEv2"
    ike_encryption: str = "aes256gcm16"
    esp_encryption: str = "aes256gcm16"
