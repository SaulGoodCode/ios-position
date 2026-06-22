/**
 * fake_wloc.js — Quantumult X 脚本 (script-response-body)
 * 
 * 工作原理：
 *   1. iPhone 发送 WiFi BSSID 请求到 Apple (gs-loc.apple.com)
 *   2. Apple 返回对应 BSSID 的真实坐标（ARPC + Protobuf 格式）
 *   3. 本脚本拦截 Apple 的响应，解析出所有 WiFi 设备的 BSSID
 *   4. 对每个设备的 Location 替换为伪造坐标
 *   5. 重新构造 ARPC 响应返回给 iPhone
 *   
 *   iPhone 看到「自己扫描的 WiFi AP → 坐标全指向同一假位置」→ 采信
 * 
 * Quantumult X 配置：
 *   [rewrite_local]
 *   ^https://gs-loc(-cn)?\.apple\.com/clls/wloc url script-response-body fake_wloc.js
 *   
 *   [mitm]
 *   hostname = gs-loc.apple.com, gs-loc-cn.apple.com
 */

// ============================================================
// 配置区 — 修改你的目标坐标
// ============================================================
const SPOOF_LAT = 39.9042;      // 纬度（北京天安门）
const SPOOF_LNG = 116.4074;     // 经度
const SPOOF_LABEL = "Beijing";
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
        let lo = value | 0;
        let hi = -1;
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
        while (bytes.length > 1 && bytes[bytes.length - 1] === 0 && (bytes[bytes.length - 2] & 0x80)) {
            bytes[bytes.length - 2] &= 0x7F;
            bytes.pop();
        }
        return bytes;
    }
    if (value > 0x7FFFFFFF) {
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
// 解析 ARPC 响应 → 提取 protobuf payload
// 
// ARPC Response 格式有两种：
//   标准: [8 bytes prefix 0x0001000000010000][2 bytes length][payload]
//   变体: 头部长度不固定
// 
// 策略：先尝试标准 10 字节偏移，验证是否是有效 protobuf
//        如果无效，扫描查找第一个 protobuf WifiDevice tag (0x12)
// ============================================================
function parseArpcResponse(data) {
    if (data.length < 10) return data;
    
    // 策略 1：标准 10 字节偏移
    const standard = data.slice(10);
    if (isValidProtobuf(standard)) {
        return standard;
    }
    
    // 策略 2：用前 8 字节匹配 prefix，然后读 2 字节长度
    if (data[0] === 0x00 && data[1] === 0x01) {
        // 可能头部后面有额外字段，尝试不同偏移
        for (let off = 8; off <= Math.min(20, data.length - 2); off++) {
            const payloadLen = (data[off] << 8) | data[off + 1];
            if (payloadLen > 0 && payloadLen <= data.length - off - 2) {
                const candidate = data.slice(off + 2, off + 2 + payloadLen);
                if (isValidProtobuf(candidate)) {
                    return candidate;
                }
            }
        }
    }
    
    // 策略 3：扫描找第一个 0x12 (field 2, wire type 2 = WifiDevice)
    // 这是 AppleWLoc 响应中 wifi_devices 字段的 tag
    for (let i = 0; i < Math.min(30, data.length); i++) {
        if (data[i] === 0x12 && i + 1 < data.length) {
            const candidate = data.slice(i);
            if (isValidProtobuf(candidate)) {
                return candidate;
            }
        }
    }
    
    // 兜底：跳过 10 字节
    return standard;
}

// 简单验证是否像 protobuf（第一个 byte 是有效 tag）
function isValidProtobuf(data) {
    if (!data || data.length < 2) return false;
    const firstByte = data[0];
    const wireType = firstByte & 0x07;
    const fieldNum = firstByte >>> 3;
    // AppleWLoc 响应第一个字段通常是 field 2 (wifi_devices) 或 field 3 (num_cell_results)
    // wire type 应该是 0 (varint) 或 2 (length-delimited)
    return (wireType === 0 || wireType === 2) && fieldNum >= 1 && fieldNum <= 33;
}

// ============================================================
// 解析 AppleWLoc protobuf 响应 — 提取 WiFi BSSIDs
// ============================================================
function parseAppleWlocResponse(data) {
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

// 字符串(Latin-1/ISO-8859-1) → 字节数组
function latin1ToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) & 0xFF);
    }
    return bytes;
}

// 字节数组 → Latin-1 字符串
function bytesToLatin1(arr) {
    let str = "";
    for (let i = 0; i < arr.length; i++) {
        str += String.fromCharCode(arr[i]);
    }
    return str;
}

// ============================================================
// 主逻辑 — script-response-body 模式
//
// QX 先把请求转发给 Apple，拿到真实响应后调用本脚本
// $response.body / $response.bodyBytes 中包含 Apple 的 ARPC 响应
// 我们从中提取真实 BSSIDs → 用伪造坐标重建 → 返回给 iPhone
// ============================================================
(function main() {
    let responseData = null;
    let wifiBssids = [];
    
    // 读取 Apple 的原始响应体
    if (typeof $response !== "undefined") {
        if ($response.bodyBytes && $response.bodyBytes.byteLength > 0) {
            responseData = new Uint8Array($response.bodyBytes);
            console.log(`[LocSpoof] Got bodyBytes: ${responseData.length}B`);
        } else if ($response.body && $response.body.length > 0) {
            // 回退: body 是 Latin-1 编码的字符串
            responseData = latin1ToBytes($response.body);
            console.log(`[LocSpoof] Got body string: ${responseData.length}B`);
        }
    }
    
    if (responseData && responseData.length > 10) {
        try {
            // 打印头部 hex 用于调试
            const headHex = Array.from(responseData.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[LocSpoof] Header: ${headHex}`);
            
            const protobufPayload = parseArpcResponse(responseData);
            console.log(`[LocSpoof] Protobuf payload: ${protobufPayload.length}B (offset=${responseData.length - protobufPayload.length})`);
            wifiBssids = parseAppleWlocResponse(protobufPayload);
            console.log(`[LocSpoof] Extracted ${wifiBssids.length} BSSIDs from Apple`);
            if (wifiBssids.length > 0 && wifiBssids.length <= 5) {
                console.log(`[LocSpoof] BSSIDs: ${wifiBssids.join(", ")}`);
            }
        } catch (e) {
            console.log(`[LocSpoof] Parse error: ${e.message}`);
        }
    } else {
        console.log("[LocSpoof] No/short response body from Apple");
    }
    
    console.log(`[LocSpoof] Spoofing ${wifiBssids.length || 1} devices → lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL})`);
    
    // 用真实 BSSIDs + 伪造坐标重建响应
    const protobuf = buildAppleWlocResponse(wifiBssids);
    const responseBytes = buildArpcResponse(protobuf);
    
    console.log(`[LocSpoof] Rebuilt: ${responseBytes.length}B`);
    
    // 返回修改后的二进制响应体
    // QX script-response-body 模式下 bodyBytes 不生效，用 Latin-1 body
    $done({ body: bytesToLatin1(responseBytes) });
})();
