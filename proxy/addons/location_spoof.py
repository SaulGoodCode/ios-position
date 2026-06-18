"""
Location Spoofing MITM Proxy Addon for mitmproxy.

Intercepts Apple Location Services requests (ARPC protocol) to
gs-loc.apple.com / gs-loc-cn.apple.com and returns spoofed
location data using the correct AppleWLoc protobuf format.

Protocol:
  Request:  ARPC binary envelope -> protobuf AppleWLoc (WiFi BSSIDs)
  Response: ARPC binary envelope -> protobuf AppleWLoc (GPS coordinates)

The proxy:
  1. Parses the ARPC envelope from the incoming request
  2. Deserializes the protobuf AppleWLoc to extract WiFi BSSIDs
  3. Builds a spoofed AppleWLoc response with fake coordinates
  4. Wraps it in an ARPC response envelope
  5. Returns the forged response to the iOS device

Reference:
  - acheong08/apple-corelocation-experiments
  - acheong08/ios-location-spoofer
"""

import time
import logging

import httpx
from mitmproxy import http, ctx

from proxy.addons.arpc import (
    ArpcRequest,
    build_arpc_response,
    ARPC_RESPONSE_PREFIX,
)
from proxy.addons.apple_wloc import (
    parse_apple_wloc,
    build_apple_wloc_response,
    coord_to_int,
)

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

import os

DEFAULT_LAT = 39.9042
DEFAULT_LNG = 116.4074
DEFAULT_H_ACCURACY = 65.0
DEFAULT_V_ACCURACY = 10.0

# API URL: read from env var for Docker, fallback to localhost
LOCATION_API = os.environ.get(
    "LOCSPOOF_API_URL",
    "http://127.0.0.1:8000/api/location"
)

# Domains to intercept
INTERCEPT_DOMAINS = [
    "gs-loc.apple.com",
    "gs-loc-cn.apple.com",
]

# Path patterns to intercept (the WiFi location endpoint)
INTERCEPT_PATHS = [
    "/clls/wloc",
]

logger = logging.getLogger("locspoof.addon")


# --------------------------------------------------------------------------
# Location cache
# --------------------------------------------------------------------------

class LocationCache:
    """Fetches and caches the spoofed location from the API backend."""

    def __init__(self, api_url: str = LOCATION_API, cache_ttl: float = 5.0):
        self.api_url = api_url
        self.cache_ttl = cache_ttl
        self._cached: dict | None = None
        self._last_fetch: float = 0.0

    def get(self) -> dict:
        now = time.time()
        if self._cached and (now - self._last_fetch) < self.cache_ttl:
            return self._cached

        try:
            resp = httpx.get(
                self.api_url,
                params={"device_id": "default"},
                timeout=3.0,
            )
            if resp.status_code == 200:
                self._cached = resp.json()
                self._last_fetch = now
                return self._cached
        except Exception as e:
            ctx.log.warn(f"[LocSpoof] API fetch failed: {e}")

        if self._cached:
            return self._cached

        return {
            "lat": DEFAULT_LAT,
            "lng": DEFAULT_LNG,
            "horizontal_accuracy": DEFAULT_H_ACCURACY,
            "vertical_accuracy": DEFAULT_V_ACCURACY,
        }


location_cache = LocationCache()


# --------------------------------------------------------------------------
# Mitmproxy Addon
# --------------------------------------------------------------------------

class LocationSpoofAddon:
    """
    Intercepts Apple Location Services ARPC requests and returns
    spoofed AppleWLoc protobuf responses.
    """

    def load(self, loader):
        ctx.log.info("[LocSpoof] Location spoofing addon loaded (ARPC/Protobuf)")

    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        path = flow.request.path

        # Check domain
        if not any(host.endswith(d) for d in INTERCEPT_DOMAINS):
            return

        # Check path (only intercept the WiFi location endpoint)
        if not any(path.startswith(p) for p in INTERCEPT_PATHS):
            ctx.log.info(f"[LocSpoof] Skipping non-wloc path: {path}")
            return

        method = flow.request.method
        body = flow.request.get_content() or b""
        ctx.log.info(
            f"[LocSpoof] Intercepting: {method} {host}{path} "
            f"body={len(body)}B "
            f"headers={dict(flow.request.headers)}"
        )

        # Parse WiFi devices from request body (if any)
        wifi_devices = []
        if body:
            try:
                arpc_req = ArpcRequest.deserialize(body)
                ctx.log.info(
                    f"[LocSpoof] ARPC v{arpc_req.version} "
                    f"locale={arpc_req.locale} "
                    f"app={arpc_req.app_identifier} "
                    f"os={arpc_req.os_version} "
                    f"payload={len(arpc_req.payload)}B"
                )
                wloc_data = parse_apple_wloc(arpc_req.payload)
                wifi_devices = wloc_data.get("wifi_devices", [])
                ctx.log.info(f"[LocSpoof] Request has {len(wifi_devices)} WiFi devices")
                for wd in wifi_devices[:3]:
                    ctx.log.info(f"  BSSID: {wd.get('bssid', 'unknown')}")
            except Exception as e:
                ctx.log.warn(f"[LocSpoof] Parse failed (will use defaults): {e}")
        else:
            ctx.log.info("[LocSpoof] Empty body - using default fake WiFi device")

        # Get the spoofed location
        loc = location_cache.get()
        lat = loc["lat"]
        lng = loc["lng"]
        h_acc = loc.get("horizontal_accuracy", DEFAULT_H_ACCURACY)
        v_acc = loc.get("vertical_accuracy", DEFAULT_V_ACCURACY)

        ctx.log.info(f"[LocSpoof] Spoofing -> lat={lat}, lng={lng}")

        # Build spoofed AppleWLoc protobuf response
        # Always provide at least one fake WiFi device
        spoofed_protobuf = build_apple_wloc_response(
            latitude=lat,
            longitude=lng,
            horizontal_accuracy=h_acc,
            altitude=loc.get("altitude", 0.0),
            vertical_accuracy=v_acc,
            wifi_devices=wifi_devices if wifi_devices else [
                {"bssid": "00:00:00:00:00:00"}
            ],
        )

        # Wrap in ARPC response envelope
        response_bytes = build_arpc_response(spoofed_protobuf)

        # Return the forged response
        flow.response = http.Response.make(
            200,
            response_bytes,
            {
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-cache, no-store",
                "X-LocSpoof": "arpc-protobuf",
            },
        )

        ctx.log.info(
            f"[LocSpoof] Response sent: "
            f"{len(response_bytes)}B "
            f"(protobuf={len(spoofed_protobuf)}B, "
            f"devices={len(wifi_devices)})"
        )

    def response(self, flow: http.HTTPFlow):
        """Log non-intercepted responses for debugging."""
        host = flow.request.pretty_host
        if any(host.endswith(d) for d in INTERCEPT_DOMAINS):
            if not flow.response.headers.get("X-LocSpoof"):
                ctx.log.warn(
                    f"[LocSpoof] WARNING: {host} response was NOT spoofed!"
                )


# Mitmproxy addon entry point
addons = [LocationSpoofAddon()]
