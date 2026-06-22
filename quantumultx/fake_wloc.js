/**
 * fake_wloc.js — Quantumult X 脚本 (script-echo-response)
 * 
 * 拦截 Apple Wi-Fi 定位服务请求，直接返回伪造坐标响应。
 * 不转发给 Apple 服务器。
 * 
 * Quantumult X 配置：
 *   [rewrite_local]
 *   ^https://gs-loc(-cn)?\.apple\.com/clls/wloc url script-echo-response fake_wloc.js
 *   
 *   [mitm]
 *   hostname = gs-loc.apple.com, gs-loc-cn.apple.com
 */

// ============================================================
// 配置区 — 修改你的目标坐标
// ============================================================
const SPOOF_LAT = 24.489826;    // 纬度（厦门）
const SPOOF_LNG = 118.180396;   // 经度
const SPOOF_LABEL = "Xiamen";
const HORIZONTAL_ACCURACY = 65; // 水平精度 (米)
const ALTITUDE = 30;            // 海拔 (米)
const VERTICAL_ACCURACY = 10;   // 垂直精度 (米)

// ============================================================
// Apple 坐标编码：经纬度 × 10^8 → int64
// ============================================================
const COORD_SCALE = 100000000;

function coordToInt(coord) {
    return Math.round(coord * COORD_SCALE);
}

// ============================================================
// Protobuf varint 编码
// ============================================================
function encodeVarint(value) {
    const bytes = [];
    if (value < 0) {
        // 负数转无符号 64 位（10 字节 varint）
        // 简化处理：手动构造 10 字节补码
        let lo = value | 0;
        let hi = -1; // 全1
        for (let i = 0; i < 4; i++) {
            bytes.push((lo & 0x7F) | 0x80);
            lo = (lo >>> 7) | (hi << 25);
            hi = hi >>> 7;
        }
        bytes.push((lo & 0x7F) | 0x80);
        lo = (lo >>> 7) | (hi << 25);
        hi = hi >>> 7;
        for (let i = 0; i < 4; i++) {
            bytes.push((lo & 0x7F) | 0x80);
            lo = (lo >>> 7) | (hi << 25);
            hi = hi >>> 7;
        }
        bytes.push(lo & 0x7F);
        // 去掉尾部多余的0字节（但保留至少1字节）
        while (bytes.length > 1 && bytes[bytes.length - 1] === 0 && (bytes[bytes.length - 2] & 0x80)) {
            bytes[bytes.length - 2] &= 0x7F;
            bytes.pop();
        }
        return bytes;
    }
    
    // 正数用标准 double 精度范围处理
    // 对于 lat/lng × 10^8 最大约 18000000000，需要 >32 位
    if (value > 0x7FFFFFFF) {
        // 大整数：逐 7 位提取
        let v = value;
        while (v > 0x7F) {
            bytes.push((v & 0x7F) | 0x80);
            v = Math.floor(v / 128);
        }
        bytes.push(v & 0x7F);
    } else {
        let v = value;
        while (v > 0x7F) {
            bytes.push((v & 0x7F) | 0x80);
            v >>>= 7;
        }
        bytes.push(v & 0x7F);
    }
    return bytes;
}

function encodeTag(fieldNumber, wireType) {
    return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeVarintField(fieldNumber, value) {
    if (value === 0) return [];
    return [...encodeTag(fieldNumber, 0), ...encodeVarint(value)];
}

function zigzagEncode(n) {
    return (n << 1) ^ (n >> 31);
}

function encodeSint32Field(fieldNumber, value) {
    if (value === 0) return [];
    const zigzag = zigzagEncode(value) >>> 0;
    return [...encodeTag(fieldNumber, 0), ...encodeVarint(zigzag)];
}

function encodeStringField(fieldNumber, str) {
    if (!str) return [];
    const encoded = stringToUtf8(str);
    return [
        ...encodeTag(fieldNumber, 2),
        ...encodeVarint(encoded.length),
        ...encoded
    ];
}

function encodeBytesField(fieldNumber, bytes) {
    if (!bytes || bytes.length === 0) return [];
    return [
        ...encodeTag(fieldNumber, 2),
        ...encodeVarint(bytes.length),
        ...bytes
    ];
}

// ============================================================
// Protobuf 解码
// ============================================================
function decodeVarint(data, offset) {
    let result = 0;
    let shift = 0;
    while (offset < data.length) {
        const byte = data[offset++];
        result += (byte & 0x7F) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [result, offset];
}

// ============================================================
// 解析 ARPC 请求
// ============================================================
function parseArpcRequest(data) {
    let offset = 0;
    
    // version (2 bytes)
    offset += 2;
    
    // locale (Pascal: 2-byte len + string)
    if (offset + 2 > data.length) return data.slice(offset);
    const localeLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + localeLen;
    
    // app identifier
    if (offset + 2 > data.length) return data.slice(offset);
    const appLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + appLen;
    
    // os version
    if (offset + 2 > data.length) return data.slice(offset);
    const osLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + osLen;
    
    // function id (4 bytes)
    offset += 4;
    
    // payload length (4 bytes uint32 BE)
    if (offset + 4 > data.length) return data.slice(offset);
    const payloadLen = (data[offset] << 24) | (data[offset+1] << 16) | 
                       (data[offset+2] << 8) | data[offset+3];
    offset += 4;
    
    return data.slice(offset, offset + payloadLen);
}

// ============================================================
// 解析 AppleWLoc protobuf — 提取 WiFi BSSIDs
// ============================================================
function parseAppleWloc(data) {
    const wifiDevices = [];
    let offset = 0;
    
    while (offset < data.length) {
        const [tagVal, newOffset] = decodeVarint(data, offset);
        offset = newOffset;
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 0x07;
        
        if (wireType === 0) {
            const [, o] = decodeVarint(data, offset);
            offset = o;
        } else if (wireType === 2) {
            const [length, o2] = decodeVarint(data, offset);
            offset = o2;
            const value = data.slice(offset, offset + length);
            offset += length;
            
            if (fieldNumber === 2) {
                const bssid = parseWifiDeviceBssid(value);
                if (bssid) wifiDevices.push(bssid);
            }
        } else if (wireType === 1) {
            offset += 8;
        } else if (wireType === 5) {
            offset += 4;
        } else {
            break;
        }
    }
    
    return wifiDevices;
}

function parseWifiDeviceBssid(data) {
    let offset = 0;
    
    while (offset < data.length) {
        const [tagVal, newOffset] = decodeVarint(data, offset);
        offset = newOffset;
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 0x07;
        
        if (wireType === 2) {
            const [length, o2] = decodeVarint(data, offset);
            offset = o2;
            const value = data.slice(offset, offset + length);
            offset += length;
            
            if (fieldNumber === 1) {
                // BSSID string
                return utf8ToString(value);
            }
        } else if (wireType === 0) {
            const [, o] = decodeVarint(data, offset);
            offset = o;
        } else if (wireType === 1) {
            offset += 8;
        } else if (wireType === 5) {
            offset += 4;
        } else {
            break;
        }
    }
    return null;
}

// ============================================================
// 构建伪造响应
// ============================================================
function buildLocation(lat, lng, hAcc, altitude, vAcc) {
    const buf = [];
    const latInt = coordToInt(lat);
    if (latInt !== 0) buf.push(...encodeVarintField(1, latInt));
    const lngInt = coordToInt(lng);
    if (lngInt !== 0) buf.push(...encodeVarintField(2, lngInt));
    if (hAcc !== 0) buf.push(...encodeVarintField(3, hAcc));
    if (altitude !== 0) buf.push(...encodeVarintField(5, altitude));
    if (vAcc !== 0) buf.push(...encodeVarintField(6, vAcc));
    return buf;
}

function buildWifiDevice(bssid, locationBytes) {
    const buf = [];
    buf.push(...encodeStringField(1, bssid));
    if (locationBytes && locationBytes.length > 0) {
        buf.push(...encodeBytesField(2, locationBytes));
    }
    return buf;
}

function buildAppleWlocResponse(wifiBssids) {
    const buf = [];
    const loc = buildLocation(SPOOF_LAT, SPOOF_LNG, HORIZONTAL_ACCURACY, ALTITUDE, VERTICAL_ACCURACY);
    
    const devices = wifiBssids.length > 0 ? wifiBssids : ["00:00:00:00:00:00"];
    for (const bssid of devices) {
        const deviceBytes = buildWifiDevice(bssid, loc);
        buf.push(...encodeBytesField(2, deviceBytes));
    }
    
    // num_cell_results = -1 (禁用蜂窝)
    buf.push(...encodeSint32Field(3, -1));
    return buf;
}

function buildArpcResponse(protobufPayload) {
    const prefix = [0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
    const len = protobufPayload.length;
    const lenBytes = [(len >> 8) & 0xFF, len & 0xFF];
    return [...prefix, ...lenBytes, ...protobufPayload];
}

// ============================================================
// 工具函数
// ============================================================
function stringToUtf8(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code <= 0x7F) {
            bytes.push(code);
        } else if (code <= 0x7FF) {
            bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
        } else {
            bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
        }
    }
    return bytes;
}

function utf8ToString(bytes) {
    let str = "";
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte <= 0x7F) {
            str += String.fromCharCode(byte);
        } else if ((byte & 0xE0) === 0xC0) {
            str += String.fromCharCode(((byte & 0x1F) << 6) | (bytes[++i] & 0x3F));
        } else if ((byte & 0xF0) === 0xE0) {
            str += String.fromCharCode(((byte & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F));
        }
    }
    return str;
}

// Uint8Array 转 ArrayBuffer (用于 QX bodyBytes)
function toArrayBuffer(arr) {
    const uint8 = new Uint8Array(arr);
    return uint8.buffer;
}

// ============================================================
// 主逻辑
// ============================================================
(function main() {
    // script-echo-response 模式：$request.bodyBytes 是 ArrayBuffer
    let wifiBssids = [];
    let bodyData = null;
    
    // 尝试读取请求体（二进制）
    if (typeof $request !== "undefined" && $request.bodyBytes) {
        bodyData = new Uint8Array($request.bodyBytes);
    }
    
    if (bodyData && bodyData.length > 0) {
        try {
            const payload = parseArpcRequest(bodyData);
            wifiBssids = parseAppleWloc(payload);
            console.log(`[LocSpoof] Parsed ${wifiBssids.length} WiFi BSSIDs from request`);
        } catch (e) {
            console.log(`[LocSpoof] Parse error: ${e.message}, using default device`);
        }
    } else {
        console.log("[LocSpoof] No request body available, using default device");
    }
    
    console.log(`[LocSpoof] Spoofing → lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL})`);
    
    // 构建伪造 ARPC 响应
    const protobuf = buildAppleWlocResponse(wifiBssids);
    const responseBytes = buildArpcResponse(protobuf);
    
    console.log(`[LocSpoof] Response: ${responseBytes.length} bytes, devices=${wifiBssids.length || 1}`);
    
    // 返回响应 — QX script-echo-response 格式
    $done({
        response: {
            status: 200,
            headers: {
                "Content-Type": "application/x-protobuf",
                "Cache-Control": "no-cache, no-store"
            },
            bodyBytes: toArrayBuffer(responseBytes)
        }
    });
})();
