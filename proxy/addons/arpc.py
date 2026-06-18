"""
ARPC (Apple Remote Procedure Call) Protocol Parser/Serializer.

This is the binary protocol used by Apple Location Services
(gs-loc.apple.com / gs-loc-cn.apple.com) for WiFi/cell-based
location lookups.

ARPC Request Format:
  [2 bytes]  Version       (uint16, big-endian)
  [2+N bytes] Locale       (Pascal string: 2-byte length + string)
  [2+N bytes] AppIdentifier (Pascal string)
  [2+N bytes] OsVersion    (Pascal string)
  [4 bytes]  FunctionId    (uint32, big-endian)
  [4 bytes]  PayloadLength (uint32, big-endian)
  [N bytes]  Payload       (protobuf-encoded AppleWLoc)

ARPC Response Format:
  [8 bytes]  Initial bytes (typically 0x0001000000010000)
  [2 bytes]  PayloadLength (uint16, big-endian)
  [N bytes]  Payload       (protobuf-encoded AppleWLoc)

Reference: acheong08/apple-corelocation-experiments
"""

import struct
from dataclasses import dataclass, field
from typing import Optional


# Standard initial bytes for ARPC responses
ARPC_RESPONSE_PREFIX = bytes.fromhex("0001000000010000")


@dataclass
class ArpcRequest:
    """Parsed ARPC request."""
    version: int = 0
    locale: str = ""
    app_identifier: str = ""
    os_version: str = ""
    function_id: int = 0
    payload: bytes = b""

    @classmethod
    def deserialize(cls, data: bytes) -> "ArpcRequest":
        """Parse an ARPC request from raw bytes."""
        req = cls()
        offset = 0

        # Version (2 bytes, uint16 BE)
        req.version = struct.unpack_from(">H", data, offset)[0]
        offset += 2

        # Locale (Pascal string)
        req.locale, offset = _read_pascal_string(data, offset)

        # App identifier (Pascal string)
        req.app_identifier, offset = _read_pascal_string(data, offset)

        # OS version (Pascal string)
        req.os_version, offset = _read_pascal_string(data, offset)

        # Function ID (4 bytes, uint32 BE)
        req.function_id = struct.unpack_from(">I", data, offset)[0]
        offset += 4

        # Payload length (4 bytes, uint32 BE)
        payload_len = struct.unpack_from(">I", data, offset)[0]
        offset += 4

        # Payload
        req.payload = data[offset : offset + payload_len]

        return req

    def serialize(self) -> bytes:
        """Serialize back to raw bytes."""
        buf = bytearray()

        # Version
        buf += struct.pack(">H", self.version)

        # Pascal strings
        buf += _write_pascal_string(self.locale)
        buf += _write_pascal_string(self.app_identifier)
        buf += _write_pascal_string(self.os_version)

        # Function ID
        buf += struct.pack(">I", self.function_id)

        # Payload length + payload
        buf += struct.pack(">I", len(self.payload))
        buf += self.payload

        return bytes(buf)


def build_arpc_response(protobuf_payload: bytes) -> bytes:
    """
    Build an ARPC response from a protobuf-encoded AppleWLoc message.

    Response format:
      [8 bytes]  Prefix (0x0001000000010000)
      [2 bytes]  Payload length (uint16 BE)
      [N bytes]  Protobuf payload
    """
    buf = bytearray()
    buf += ARPC_RESPONSE_PREFIX
    buf += struct.pack(">H", len(protobuf_payload))
    buf += protobuf_payload
    return bytes(buf)


def parse_arpc_response(data: bytes) -> bytes:
    """
    Parse an ARPC response, returning just the protobuf payload.

    The response has a variable-length header; based on the reference
    implementation, the protobuf starts at offset 10.
    """
    if len(data) < 10:
        raise ValueError("ARPC response too short")
    # Skip the first 10 bytes (8-byte prefix + 2-byte length)
    return data[10:]


# --------------------------------------------------------------------------
# Internal helpers
# --------------------------------------------------------------------------

def _read_pascal_string(data: bytes, offset: int) -> tuple:
    """Read a Pascal string (2-byte length prefix + string bytes)."""
    length = struct.unpack_from(">H", data, offset)[0]
    offset += 2
    s = data[offset : offset + length].decode("utf-8", errors="replace")
    offset += length
    return s, offset


def _write_pascal_string(s: str) -> bytes:
    """Write a Pascal string (2-byte length prefix + string bytes)."""
    encoded = s.encode("utf-8")
    return struct.pack(">H", len(encoded)) + encoded
