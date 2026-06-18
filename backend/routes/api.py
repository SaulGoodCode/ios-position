"""
API routes - Location management and status endpoints.
"""

import uuid
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.models import LocationPoint
from backend.services.location_store import location_store

router = APIRouter(prefix="/api", tags=["api"])


class SetLocationRequest(BaseModel):
    lat: float
    lng: float
    label: str = ""
    altitude: float = 0.0
    horizontal_accuracy: float = 65.0
    vertical_accuracy: float = 10.0
    device_id: str = "default"
    device_name: str = ""


class LocationResponse(BaseModel):
    lat: float
    lng: float
    label: str
    altitude: float
    horizontal_accuracy: float
    vertical_accuracy: float
    timestamp: float


@router.get("/location", response_model=LocationResponse)
def get_current_location(device_id: str = Query(default="default")):
    """Get the currently configured spoofed location."""
    loc = location_store.get_location_for_device(device_id)
    return LocationResponse(
        lat=loc.lat,
        lng=loc.lng,
        label=loc.label,
        altitude=loc.altitude,
        horizontal_accuracy=loc.horizontal_accuracy,
        vertical_accuracy=loc.vertical_accuracy,
        timestamp=loc.timestamp,
    )


@router.post("/location", response_model=LocationResponse)
def set_location(req: SetLocationRequest):
    """Set the spoofed location for a device."""
    loc = LocationPoint(
        lat=req.lat,
        lng=req.lng,
        label=req.label,
        altitude=req.altitude,
        horizontal_accuracy=req.horizontal_accuracy,
        vertical_accuracy=req.vertical_accuracy,
    )
    location_store.set_location(req.device_id, loc, req.device_name)
    return LocationResponse(
        lat=loc.lat,
        lng=loc.lng,
        label=loc.label,
        altitude=loc.altitude,
        horizontal_accuracy=loc.horizontal_accuracy,
        vertical_accuracy=loc.vertical_accuracy,
        timestamp=loc.timestamp,
    )


@router.get("/devices")
def list_devices():
    """List all configured devices."""
    return location_store.list_devices()


@router.delete("/devices/{device_id}")
def remove_device(device_id: str):
    """Remove a device configuration."""
    success = location_store.remove_device(device_id)
    if not success:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"status": "ok"}


@router.get("/status")
def service_status():
    """Health check and service status."""
    from backend.services.cert_manager import cert_manager
    certs_ok = cert_manager.verify_certs_exist()
    return {
        "status": "running",
        "time": time.time(),
        "certs_installed": certs_ok,
        "devices": len(location_store.list_devices()),
    }
