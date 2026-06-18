"""
AppleWLoc Protobuf Message Builder (Pure Python).

Constructs protobuf-encoded AppleWLoc messages without requiring
the protobuf compiler or generated code. Uses manual binary
construction based on the reverse-engineered schema.

Schema reference: acheong08/apple-corelocation-experiments/pb/BSSIDApple.proto

Key message types:
  AppleWLoc  - Top-level container for WiFi/cell location data
  WifiDevice - A single WiFi AP with BSSID and optional Location
  CellTower  - A cell tower with MCC/MNC/CellID and optional Location
  Location   - GPS coordinates (lat/lng stored as int64 = coord * 10^8)

Coordinate conversion:
  encode: int64_value = int(float_coord * 10^8)
  decode: float_coord = int64_value * 10^(-8)
"""

import struct
from typing import Optional, List


# --------------------------------------------------------------------------
# Coordinate conversion
# --------------------------------------------------------------------------

COORD_SCALE = 10**8  # Apple uses 10^8 scaling for coordinates


def coord_to_int(coord: float) -> int:
    """Convert a float coordinate (degrees) to Apple's int64 format."""
    return int(coord * COORD_SCALE)


def int_to_coord(n: int) -> float:
    """Convert Apple's int64 coordinate back to float degrees."""
    return n / COORD_SCALE


# --------------------------------------------------------------------------
# Protobuf wire format primitives
# --------------------------------------------------------------------------

# Wire types
VARINT = 0
FIXED64 = 1
LENGTH_DELIMITED = 2
FIXED32 = 5


def _encode_varint(value: int) -> bytes:
    """Encode an integer as a protobuf varint."""
    # Handle negative values using signed encoding (zigzag not needed
    # for int64/sint64 since we use the raw value)
    if value < 0:
        # Protobuf uses 10-byte varint for negative int64
        value = value & 0xFFFFFFFFFFFFFFFF
    result = bytearray()
    while value > 0x7F:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.append(value & 0x7F)
    return bytes(result)


def _encode_tag(field_number: int, wire_type: int) -> bytes:
    """Encode a protobuf field tag."""
    return _encode_varint((field_number << 3) | wire_type)


def _encode_varint_field(field_number: int, value: int) -> bytes:
    """Encode a varint field (int32, int64, sint32, sint64, etc.)."""
    if value == 0:
        return b""  # Default values are omitted in proto3
    return _encode_tag(field_number, VARINT) + _encode_varint(value)


def _encode_sint32_field(field_number: int, value: int) -> bytes:
    """Encode a sint32 field with zigzag encoding."""
    if value == 0:
        return b""
    # Zigzag encode: (n << 1) ^ (n >> 31)
    zigzag = (value << 1) ^ (value >> 31)
    return _encode_tag(field_number, VARINT) + _encode_varint(zigzag & 0xFFFFFFFF)


def _encode_string_field(field_number: int, value: str) -> bytes:
    """Encode a string field."""
    if not value:
        return b""
    encoded = value.encode("utf-8")
    return _encode_tag(field_number, LENGTH_DELIMITED) + _encode_varint(len(encoded)) + encoded


def _encode_bytes_field(field_number: int, value: bytes) -> bytes:
    """Encode a bytes/submessage field."""
    if not value:
        return b""
    return _encode_tag(field_number, LENGTH_DELIMITED) + _encode_varint(len(value)) + value


# --------------------------------------------------------------------------
# Protobuf message builders
# --------------------------------------------------------------------------

def build_location(
    latitude: float,
    longitude: float,
    horizontal_accuracy: float = 65.0,
    altitude: float = 0.0,
    vertical_accuracy: float = 10.0,
    speed: float = 0.0,
    course: float = 0.0,
    timestamp: int = 0,
) -> bytes:
    """
    Build a protobuf-encoded Location message.

    Location {
        optional int64 latitude  = 1;   // coord * 10^8
        optional int64 longitude = 2;   // coord * 10^8
        optional int64 horizontal_accuracy = 3;
        optional int64 altitude  = 5;
        optional int64 vertical_accuracy = 6;
        optional int64 speed     = 7;
        optional int64 course    = 8;
        optional int64 timestamp = 9;
    }
    """
    buf = bytearray()

    # Field 1: latitude (int64)
    lat_int = coord_to_int(latitude)
    if lat_int != 0:
        buf += _encode_varint_field(1, lat_int)

    # Field 2: longitude (int64)
    lng_int = coord_to_int(longitude)
    if lng_int != 0:
        buf += _encode_varint_field(2, lng_int)

    # Field 3: horizontal_accuracy (int64)
    h_acc_int = coord_to_int(horizontal_accuracy)
    if h_acc_int != 0:
        buf += _encode_varint_field(3, h_acc_int)

    # Field 5: altitude (int64)
    alt_int = coord_to_int(altitude)
    if alt_int != 0:
        buf += _encode_varint_field(5, alt_int)

    # Field 6: vertical_accuracy (int64)
    v_acc_int = coord_to_int(vertical_accuracy)
    if v_acc_int != 0:
        buf += _encode_varint_field(6, v_acc_int)

    # Field 7: speed (int64)
    speed_int = coord_to_int(speed)
    if speed_int != 0:
        buf += _encode_varint_field(7, speed_int)

    # Field 8: course (int64)
    course_int = coord_to_int(course)
    if course_int != 0:
        buf += _encode_varint_field(8, course_int)

    # Field 9: timestamp (int64, milliseconds)
    if timestamp != 0:
        buf += _encode_varint_field(9, timestamp)

    return bytes(buf)


def build_wifi_device(bssid: str, location_bytes: Optional[bytes] = None) -> bytes:
    """
    Build a protobuf-encoded WifiDevice message.

    WifiDevice {
        string bssid = 1;
        optional Location location = 2;
    }
    """
    buf = bytearray()

    # Field 1: bssid (string)
    buf += _encode_string_field(1, bssid)

    # Field 2: location (submessage)
    if location_bytes:
        buf += _encode_bytes_field(2, location_bytes)

    return bytes(buf)


def build_cell_tower(
    mcc: int,
    mnc: int,
    cell_id: int,
    tac_id: int,
    location_bytes: Optional[bytes] = None,
) -> bytes:
    """
    Build a protobuf-encoded CellTower message.

    CellTower {
        uint32 mcc = 1;
        uint32 mnc = 2;
        uint32 cell_id = 3;
        uint32 tac_id = 4;
        optional Location location = 5;
    }
    """
    buf = bytearray()

    buf += _encode_varint_field(1, mcc)
    buf += _encode_varint_field(2, mnc)
    buf += _encode_varint_field(3, cell_id)
    buf += _encode_varint_field(4, tac_id)

    if location_bytes:
        buf += _encode_bytes_field(5, location_bytes)

    return bytes(buf)


def build_apple_wloc_response(
    latitude: float,
    longitude: float,
    horizontal_accuracy: float = 65.0,
    altitude: float = 0.0,
    vertical_accuracy: float = 10.0,
    wifi_devices: Optional[List[dict]] = None,
) -> bytes:
    """
    Build a complete protobuf-encoded AppleWLoc response message.

    This is the spoofed response that replaces Apple's real location data.

    AppleWLoc {
        repeated WifiDevice wifi_devices = 2;
        optional sint32 num_cell_results = 3;  // set to -1 to disable
        optional sint32 num_wifi_results = 4;
        optional string app_bundle_id = 5;
        repeated CellTower cell_tower_response = 22;
    }

    For spoofing, we:
    1. Set the same Location on ALL WiFi devices in the request
    2. Clear num_cell_results, num_wifi_results, device_type
    3. Return the modified message
    """
    buf = bytearray()

    # Build the shared location
    loc = build_location(
        latitude=latitude,
        longitude=longitude,
        horizontal_accuracy=horizontal_accuracy,
        altitude=altitude,
        vertical_accuracy=vertical_accuracy,
    )

    # Field 2: wifi_devices (repeated submessage)
    if wifi_devices:
        for wd in wifi_devices:
            device_bytes = build_wifi_device(
                bssid=wd.get("bssid", "00:00:00:00:00:00"),
                location_bytes=loc,
            )
            buf += _encode_bytes_field(2, device_bytes)

    # Field 3: num_cell_results = -1 (disable cell results)
    buf += _encode_sint32_field(3, -1)

    return bytes(buf)


# --------------------------------------------------------------------------
# Simple protobuf parser for AppleWLoc (read incoming requests)
# --------------------------------------------------------------------------

def parse_apple_wloc(data: bytes) -> dict:
    """
    Parse an AppleWLoc protobuf message into a Python dict.
    Extracts WiFi device BSSIDs and any existing location data.

    Returns:
        {
            "wifi_devices": [{"bssid": "AA:BB:...", "location": {...}}, ...],
            "num_cell_results": int,
            "num_wifi_results": int,
            "app_bundle_id": str,
            "device_type": {"os": str, "model": str},
        }
    """
    result = {
        "wifi_devices": [],
        "num_cell_results": 0,
        "num_wifi_results": 0,
        "app_bundle_id": "",
        "device_type": {},
        "raw": data,
    }

    offset = 0
    while offset < len(data):
        # Read tag
        tag_val, offset = _decode_varint(data, offset)
        field_number = tag_val >> 3
        wire_type = tag_val & 0x07

        if wire_type == VARINT:
            value, offset = _decode_varint(data, offset)
            if field_number == 3:
                # sint32 with zigzag decoding
                result["num_cell_results"] = _zigzag_decode(value)
            elif field_number == 4:
                result["num_wifi_results"] = _zigzag_decode(value)

        elif wire_type == LENGTH_DELIMITED:
            length, offset = _decode_varint(data, offset)
            value = data[offset : offset + length]
            offset += length

            if field_number == 2:
                # WifiDevice submessage
                wd = _parse_wifi_device(value)
                result["wifi_devices"].append(wd)
            elif field_number == 5:
                result["app_bundle_id"] = value.decode("utf-8", errors="replace")
            elif field_number == 33:
                result["device_type"] = _parse_device_type(value)
        else:
            # Skip unknown wire types
            if wire_type == FIXED64:
                offset += 8
            elif wire_type == FIXED32:
                offset += 4
            else:
                break  # Unknown, stop parsing

    return result


def _parse_wifi_device(data: bytes) -> dict:
    """Parse a WifiDevice submessage."""
    result = {"bssid": "", "location": None}
    offset = 0

    while offset < len(data):
        tag_val, offset = _decode_varint(data, offset)
        field_number = tag_val >> 3
        wire_type = tag_val & 0x07

        if wire_type == LENGTH_DELIMITED:
            length, offset = _decode_varint(data, offset)
            value = data[offset : offset + length]
            offset += length

            if field_number == 1:
                result["bssid"] = value.decode("utf-8", errors="replace")
            elif field_number == 2:
                result["location"] = _parse_location(value)
        else:
            if wire_type == VARINT:
                _, offset = _decode_varint(data, offset)
            elif wire_type == FIXED64:
                offset += 8
            elif wire_type == FIXED32:
                offset += 4
            else:
                break

    return result


def _parse_location(data: bytes) -> dict:
    """Parse a Location submessage."""
    result = {}
    offset = 0

    while offset < len(data):
        tag_val, offset = _decode_varint(data, offset)
        field_number = tag_val >> 3
        wire_type = tag_val & 0x07

        if wire_type == VARINT:
            value, offset = _decode_varint(data, offset)
            # Sign-extend for int64
            if value >= (1 << 63):
                value -= (1 << 64)

            field_map = {
                1: "latitude", 2: "longitude", 3: "horizontal_accuracy",
                5: "altitude", 6: "vertical_accuracy", 7: "speed",
                8: "course", 9: "timestamp",
            }
            if field_number in field_map:
                if field_number in (1, 2):
                    result[field_map[field_number]] = int_to_coord(value)
                else:
                    result[field_map[field_number]] = value
        else:
            if wire_type == LENGTH_DELIMITED:
                length, offset = _decode_varint(data, offset)
                offset += length
            elif wire_type == FIXED64:
                offset += 8
            elif wire_type == FIXED32:
                offset += 4
            else:
                break

    return result


def _parse_device_type(data: bytes) -> dict:
    """Parse a DeviceType submessage."""
    result = {"os": "", "model": ""}
    offset = 0

    while offset < len(data):
        tag_val, offset = _decode_varint(data, offset)
        field_number = tag_val >> 3
        wire_type = tag_val & 0x07

        if wire_type == LENGTH_DELIMITED:
            length, offset = _decode_varint(data, offset)
            value = data[offset : offset + length]
            offset += length

            if field_number == 1:
                result["os"] = value.decode("utf-8", errors="replace")
            elif field_number == 2:
                result["model"] = value.decode("utf-8", errors="replace")
        else:
            if wire_type == VARINT:
                _, offset = _decode_varint(data, offset)
            else:
                break

    return result


def _decode_varint(data: bytes, offset: int) -> tuple:
    """Decode a protobuf varint from data at the given offset."""
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, offset


def _zigzag_decode(n: int) -> int:
    """Decode a zigzag-encoded signed integer."""
    return (n >> 1) ^ -(n & 1)
