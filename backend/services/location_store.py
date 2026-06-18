"""
Location storage service - persists spoofed locations per device/user.
Uses a simple JSON file store for personal-use scale.
"""

import json
import time
import threading
from pathlib import Path
from typing import Optional, Dict

from backend.models import LocationPoint


class LocationStore:
    """Thread-safe JSON file-backed location store."""

    def __init__(self, data_dir: str = "./data"):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.file_path = self.data_dir / "locations.json"
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}
        self._load()

    def _load(self):
        if self.file_path.exists():
            with open(self.file_path, "r", encoding="utf-8") as f:
                self._data = json.load(f)

    def _save(self):
        with open(self.file_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    def get_location(self, device_id: str) -> Optional[LocationPoint]:
        """Get the currently configured location for a device."""
        with self._lock:
            entry = self._data.get(device_id)
            if entry and entry.get("location"):
                return LocationPoint(**entry["location"])
            return None

    def set_location(self, device_id: str, location: LocationPoint, device_name: str = ""):
        """Set the spoofed location for a device."""
        with self._lock:
            self._data[device_id] = {
                "device_id": device_id,
                "device_name": device_name,
                "location": location.model_dump(),
                "updated_at": time.time(),
            }
            self._save()

    def get_default_location(self) -> LocationPoint:
        """Return a default location (Beijing) if none is configured."""
        return LocationPoint(
            lat=39.9042,
            lng=116.4074,
            label="Beijing, China",
            horizontal_accuracy=65.0,
        )

    def get_location_for_device(self, device_id: str) -> LocationPoint:
        """Get device location or fall back to default."""
        loc = self.get_location(device_id)
        return loc if loc else self.get_default_location()

    def list_devices(self) -> list:
        """List all configured devices."""
        with self._lock:
            return list(self._data.values())

    def remove_device(self, device_id: str) -> bool:
        with self._lock:
            if device_id in self._data:
                del self._data[device_id]
                self._save()
                return True
            return False


# Global instance
location_store = LocationStore()
