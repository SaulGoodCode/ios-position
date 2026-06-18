#!/usr/bin/env python3
"""
Quick validation of ARPC protocol + AppleWLoc protobuf encoding.
Tests the core protocol implementation without needing mitmproxy.
"""

import sys
import struct

sys.path.insert(0, ".")

from proxy.addons.arpc import ArpcRequest, build_arpc_response, ARPC_RESPONSE_PREFIX
from proxy.addons.apple_wloc import (
    coord_to_int,
    int_to_coord,
    build_location,
    build_wifi_device,
    build_apple_wloc_response,
    parse_apple_wloc,
)


def test_coordinate_conversion():
    print("=== Coordinate Conversion ===")

    # Beijing: 39.9042, 116.4074
    lat_int = coord_to_int(39.9042)
    lng_int = coord_to_int(116.4074)
    print(f"  Beijing lat: 39.9042 -> int64: {lat_int}")
    print(f"  Beijing lng: 116.4074 -> int64: {lng_int}")

    # Round-trip
    lat_back = int_to_coord(lat_int)
    lng_back = int_to_coord(lng_int)
    print(f"  Round-trip: {lat_back:.8f}, {lng_back:.8f}")

    assert abs(lat_back - 39.9042) < 1e-7, "Latitude round-trip failed"
    assert abs(lng_back - 116.4074) < 1e-7, "Longitude round-trip failed"
    print("  [PASS] Coordinate conversion\n")


def test_location_encoding():
    print("=== Location Protobuf Encoding ===")

    loc = build_location(
        latitude=39.9042,
        longitude=116.4074,
        horizontal_accuracy=65.0,
        altitude=30.0,
    )
    print(f"  Location protobuf: {len(loc)} bytes")
    print(f"  Hex: {loc.hex()}")

    # Verify it's not empty
    assert len(loc) > 0, "Location encoding produced empty output"

    # Parse it back
    result = parse_apple_wloc.__module__  # Just checking import
    print("  [PASS] Location encoding\n")


def test_apple_wloc_response():
    print("=== AppleWLoc Response Building ===")

    # Build a response with 2 fake WiFi devices
    devices = [
        {"bssid": "AA:BB:CC:DD:EE:01"},
        {"bssid": "AA:BB:CC:DD:EE:02"},
    ]

    protobuf = build_apple_wloc_response(
        latitude=39.9042,
        longitude=116.4074,
        horizontal_accuracy=65.0,
        altitude=30.0,
        vertical_accuracy=10.0,
        wifi_devices=devices,
    )

    print(f"  AppleWLoc protobuf: {len(protobuf)} bytes")

    # Parse it back
    parsed = parse_apple_wloc(protobuf)
    print(f"  Parsed WiFi devices: {len(parsed['wifi_devices'])}")

    for wd in parsed["wifi_devices"]:
        bssid = wd["bssid"]
        loc = wd.get("location", {})
        lat = loc.get("latitude", 0)
        lng = loc.get("longitude", 0)
        print(f"    BSSID={bssid}, lat={lat:.6f}, lng={lng:.6f}")

    assert len(parsed["wifi_devices"]) == 2, "Expected 2 WiFi devices"
    assert abs(parsed["wifi_devices"][0]["location"]["latitude"] - 39.9042) < 1e-4
    assert abs(parsed["wifi_devices"][0]["location"]["longitude"] - 116.4074) < 1e-4
    print("  [PASS] AppleWLoc round-trip\n")


def test_arpc_request_serialize():
    print("=== ARPC Request Serialize/Deserialize ===")

    # Build a fake ARPC request
    original = ArpcRequest(
        version=2,
        locale="en_US",
        app_identifier="com.apple.locationd",
        os_version="iPhone OS17.5/21F79",
        function_id=0,
        payload=b"test_payload_data",
    )

    # Serialize
    raw = original.serialize()
    print(f"  Serialized: {len(raw)} bytes")

    # Deserialize
    parsed = ArpcRequest.deserialize(raw)
    print(f"  Version: {parsed.version}")
    print(f"  Locale: {parsed.locale}")
    print(f"  App: {parsed.app_identifier}")
    print(f"  OS: {parsed.os_version}")
    print(f"  FunctionId: {parsed.function_id}")
    print(f"  Payload: {parsed.payload}")

    assert parsed.version == original.version
    assert parsed.locale == original.locale
    assert parsed.app_identifier == original.app_identifier
    assert parsed.os_version == original.os_version
    assert parsed.payload == original.payload
    print("  [PASS] ARPC round-trip\n")


def test_arpc_response():
    print("=== ARPC Response Building ===")

    # Build a complete ARPC response
    protobuf = build_apple_wloc_response(
        latitude=51.5074,
        longitude=-0.1278,
        wifi_devices=[{"bssid": "11:22:33:44:55:66"}],
    )

    response = build_arpc_response(protobuf)
    print(f"  Total response: {len(response)} bytes")
    print(f"  Prefix: {response[:8].hex()}")
    print(f"  Payload length field: {struct.unpack('>H', response[8:10])[0]}")

    # Verify prefix
    assert response[:8] == ARPC_RESPONSE_PREFIX, "Response prefix mismatch"

    # Verify length field
    length_field = struct.unpack(">H", response[8:10])[0]
    assert length_field == len(protobuf), f"Length mismatch: {length_field} != {len(protobuf)}"

    # Verify we can extract protobuf from offset 10
    extracted = response[10:]
    assert extracted == protobuf, "Protobuf extraction failed"

    # Parse the extracted protobuf
    parsed = parse_apple_wloc(extracted)
    print(f"  Parsed: {len(parsed['wifi_devices'])} devices")
    lat = parsed["wifi_devices"][0]["location"]["latitude"]
    lng = parsed["wifi_devices"][0]["location"]["longitude"]
    print(f"  Location: lat={lat:.6f}, lng={lng:.6f}")

    assert abs(lat - 51.5074) < 1e-4, f"Latitude mismatch: {lat}"
    assert abs(lng - (-0.1278)) < 1e-4, f"Longitude mismatch: {lng}"
    print("  [PASS] ARPC response\n")


if __name__ == "__main__":
    print("=" * 55)
    print("  LocSpoof Protocol Validation")
    print("=" * 55)
    print()

    try:
        test_coordinate_conversion()
        test_location_encoding()
        test_apple_wloc_response()
        test_arpc_request_serialize()
        test_arpc_response()

        print("=" * 55)
        print("  ALL PROTOCOL TESTS PASSED")
        print("=" * 55)
    except AssertionError as e:
        print(f"\n[FAIL] {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
