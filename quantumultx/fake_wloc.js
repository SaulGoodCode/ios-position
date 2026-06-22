/**
 * fake_wloc.js — Quantumult X 脚本
 * 
 * 拦截 Apple Wi-Fi 定位服务 (gs-loc.apple.com / gs-loc-cn.apple.com)
 * 的 ARPC/Protobuf 请求，返回伪造坐标。
 * 
 * 协议格式：
 *   请求: ARPC binary envelope → protobuf AppleWLoc (WiFi BSSIDs)
 *   响应: ARPC binary envelope → protobuf AppleWLoc (伪造 GPS 坐标)
 * 
 * ARPC Response:
 *   [8 bytes] prefix: 0x0001000000010000
 *   [2 bytes] payload length (uint16 big-endian)
 *   [N bytes] protobuf payload
 * 
 * 使用方法：
 *   1. 修改下方 SPOOF_LAT / SPOOF_LNG / SPOOF_LABEL
 *   2. 在 Quantumult X 配置中添加 [rewrite_local] 和 [mitm] 规则
 *   3. 确保 Quantumult X 的 CA 证书已安装并信任
 *   4. 关闭定位服务 5 秒后重新打开，打开「地图」即可看到伪造位置
 */

// ============================================================
// 配置区 — 修改你的目标坐标
// ============================================================
const SPOOF_LAT = 24.598709;    // 纬度（厦门）
const SPOOF_LNG = 118.075349;   // 经度
const SPOOF_LABEL = "Xiamen";   // 标签（仅用于日志）
const HORIZONTAL_ACCURACY = 65; // 水平精度 (米)
const ALTITUDE = 30;            // 海拔 (米)
const VERTICAL_ACCURACY = 10;   // 垂直精度 (米)

// ============================================================
// Apple 坐标编码：经纬度 × 10^8 → int64
// ============================================================
const COORD_SCALE = 100000000;  // 10^8

function coordToInt(coord) {
    return Math.round(coord * COORD_SCALE);
}

// ============================================================
// Protobuf varint 编码（支持大整数和负数）
// ============================================================
function encodeVarint(value) {
    const bytes = [];
    // 处理负数 → 转为无符号 64 位表示
    if (value < 0) {
        // JavaScript 中用 BigInt 处理
        let bigVal = BigInt(value) & BigInt("0xFFFFFFFFFFFFFFFF");
        while (bigVal > 0x7Fn) {
            bytes.push(Number(bigVal & 0x7Fn) | 0x80);
            bigVal >>= 7n;
        }
        bytes.push(Number(bigVal & 0x7Fn));
        return bytes;
    }
    // 正数 / 零
    let v = value;
    if (typeof v === "bigint") {
        while (v > 0x7Fn) {
            bytes.push(Number(v & 0x7Fn) | 0x80);
            v >>= 7n;
        }
        bytes.push(Number(v & 0x7Fn));
    } else {
        // 普通 number
        while (v > 0x7F) {
            bytes.push((v & 0x7F) | 0x80);
            v = Math.floor(v / 128); // 避免位运算溢出
        }
        bytes.push(v & 0x7F);
    }
    return bytes;
}

// 编码 tag (field_number << 3 | wire_type)
function encodeTag(fieldNumber, wireType) {
    return encodeVarint((fieldNumber << 3) | wireType);
}

// 编码 varint 字段
function encodeVarintField(fieldNumber, value) {
    if (value === 0) return [];
    return [...encodeTag(fieldNumber, 0), ...encodeVarint(value)];
}

// zigzag 编码 sint32
function zigzagEncode(n) {
    return (n << 1) ^ (n >> 31);
}

// 编码 sint32 字段
function encodeSint32Field(fieldNumber, value) {
    if (value === 0) return [];
    const zigzag = zigzagEncode(value) >>> 0; // 转无符号
    return [...encodeTag(fieldNumber, 0), ...encodeVarint(zigzag)];
}

// 编码 string 字段
function encodeStringField(fieldNumber, str) {
    if (!str) return [];
    const encoded = stringToBytes(str);
    return [
        ...encodeTag(fieldNumber, 2),
        ...encodeVarint(encoded.length),
        ...encoded
    ];
}

// 编码 bytes/submessage 字段
function encodeBytesField(fieldNumber, bytes) {
    if (!bytes || bytes.length === 0) return [];
    return [
        ...encodeTag(fieldNumber, 2),
        ...encodeVarint(bytes.length),
        ...bytes
    ];
}

// ============================================================
// Protobuf varint 解码
// ============================================================
function decodeVarint(data, offset) {
    let result = 0;
    let shift = 0;
    while (offset < data.length) {
        const byte = data[offset];
        offset++;
        result |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        // 超过 32 位用 BigInt（简化处理：对于常规字段不会超）
        if (shift >= 28) {
            // 切换到 BigInt 模式
            let bigResult = BigInt(result);
            while (offset < data.length) {
                const b = data[offset];
                offset++;
                bigResult |= BigInt(b & 0x7F) << BigInt(shift);
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            return [bigResult, offset];
        }
    }
    return [result, offset];
}

// ============================================================
// 解析 ARPC 请求 — 提取 protobuf payload
// ============================================================
function parseArpcRequest(data) {
    let offset = 0;
    
    // version (2 bytes)
    offset += 2;
    
    // locale (Pascal string: 2-byte len + str)
    const localeLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + localeLen;
    
    // app identifier (Pascal string)
    const appLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + appLen;
    
    // os version (Pascal string)
    const osLen = (data[offset] << 8) | data[offset + 1];
    offset += 2 + osLen;
    
    // function id (4 bytes)
    offset += 4;
    
    // payload length (4 bytes, uint32 BE)
    const payloadLen = (data[offset] << 24) | (data[offset+1] << 16) | 
                       (data[offset+2] << 8) | data[offset+3];
    offset += 4;
    
    // payload
    const payload = data.slice(offset, offset + payloadLen);
    return payload;
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
        const fieldNumber = Number(tagVal) >> 3;
        const wireType = Number(tagVal) & 0x07;
        
        if (wireType === 0) {
            // varint — skip
            const [, o] = decodeVarint(data, offset);
            offset = o;
        } else if (wireType === 2) {
            // length-delimited
            const [length, o2] = decodeVarint(data, offset);
            offset = o2;
            const value = data.slice(offset, offset + Number(length));
            offset += Number(length);
            
            if (fieldNumber === 2) {
                // WifiDevice submessage — 提取 bssid
                const bssid = parseWifiDevice(value);
                if (bssid) wifiDevices.push(bssid);
            }
        } else if (wireType === 1) {
            offset += 8; // fixed64
        } else if (wireType === 5) {
            offset += 4; // fixed32
        } else {
            break;
        }
    }
    
    return wifiDevices;
}

function parseWifiDevice(data) {
    let offset = 0;
    let bssid = "";
    
    while (offset < data.length) {
        const [tagVal, newOffset] = decodeVarint(data, offset);
        offset = newOffset;
        const fieldNumber = Number(tagVal) >> 3;
        const wireType = Number(tagVal) & 0x07;
        
        if (wireType === 2) {
            const [length, o2] = decodeVarint(data, offset);
            offset = o2;
            const value = data.slice(offset, offset + Number(length));
            offset += Number(length);
            
            if (fieldNumber === 1) {
                bssid = bytesToString(value);
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
    
    return bssid || "00:00:00:00:00:00";
}

// ============================================================
// 构建伪造 Location protobuf
// ============================================================
function buildLocation(lat, lng, hAcc, altitude, vAcc) {
    const buf = [];
    
    // Field 1: latitude (int64 = coord × 10^8)
    const latInt = coordToInt(lat);
    if (latInt !== 0) buf.push(...encodeVarintField(1, latInt));
    
    // Field 2: longitude (int64 = coord × 10^8)
    const lngInt = coordToInt(lng);
    if (lngInt !== 0) buf.push(...encodeVarintField(2, lngInt));
    
    // Field 3: horizontal_accuracy (raw int, NOT scaled)
    if (hAcc !== 0) buf.push(...encodeVarintField(3, hAcc));
    
    // Field 5: altitude (raw int)
    if (altitude !== 0) buf.push(...encodeVarintField(5, altitude));
    
    // Field 6: vertical_accuracy (raw int)
    if (vAcc !== 0) buf.push(...encodeVarintField(6, vAcc));
    
    return buf;
}

// ============================================================
// 构建伪造 WifiDevice protobuf
// ============================================================
function buildWifiDevice(bssid, locationBytes) {
    const buf = [];
    
    // Field 1: bssid (string)
    buf.push(...encodeStringField(1, bssid));
    
    // Field 2: location (submessage)
    if (locationBytes && locationBytes.length > 0) {
        buf.push(...encodeBytesField(2, locationBytes));
    }
    
    return buf;
}

// ============================================================
// 构建完整 AppleWLoc Response protobuf
// ============================================================
function buildAppleWlocResponse(wifiBssids) {
    const buf = [];
    
    // 构建共享的 location
    const loc = buildLocation(
        SPOOF_LAT, SPOOF_LNG,
        HORIZONTAL_ACCURACY, ALTITUDE, VERTICAL_ACCURACY
    );
    
    // Field 2: wifi_devices (repeated submessage)
    // 对请求中每个 WiFi 设备都返回相同的伪造坐标
    const devices = wifiBssids.length > 0 ? wifiBssids : ["00:00:00:00:00:00"];
    for (const bssid of devices) {
        const deviceBytes = buildWifiDevice(bssid, loc);
        buf.push(...encodeBytesField(2, deviceBytes));
    }
    
    // Field 3: num_cell_results = -1 (sint32 zigzag, 禁用蜂窝结果)
    buf.push(...encodeSint32Field(3, -1));
    
    return buf;
}

// ============================================================
// 构建 ARPC 响应封装
// ============================================================
function buildArpcResponse(protobufPayload) {
    // ARPC response: [8 bytes prefix] [2 bytes length] [payload]
    const prefix = [0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00];
    const len = protobufPayload.length;
    const lenBytes = [(len >> 8) & 0xFF, len & 0xFF];
    return new Uint8Array([...prefix, ...lenBytes, ...protobufPayload]);
}

// ============================================================
// 工具函数
// ============================================================
function stringToBytes(str) {
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

function bytesToString(bytes) {
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

// ============================================================
// 主逻辑
// ============================================================
(function main() {
    const reqBody = $request.bodyBytes;
    
    if (!reqBody || reqBody.length === 0) {
        console.log("[LocSpoof] Empty request body, returning default spoof");
        const protobuf = buildAppleWlocResponse([]);
        const response = buildArpcResponse(protobuf);
        $done({
            response: {
                status: 200,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Cache-Control": "no-cache, no-store"
                },
                bodyBytes: response.buffer
            }
        });
        return;
    }
    
    // 转 Uint8Array
    const data = new Uint8Array(reqBody);
    
    // 解析 ARPC 请求 → 提取 protobuf payload
    let wifiBssids = [];
    try {
        const payload = parseArpcRequest(data);
        wifiBssids = parseAppleWloc(payload);
        console.log(`[LocSpoof] Parsed ${wifiBssids.length} WiFi devices`);
    } catch (e) {
        console.log(`[LocSpoof] Parse error: ${e.message}, using defaults`);
    }
    
    console.log(`[LocSpoof] Spoofing → lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL})`);
    
    // 构建伪造响应
    const protobuf = buildAppleWlocResponse(wifiBssids);
    const response = buildArpcResponse(protobuf);
    
    console.log(`[LocSpoof] Response: ${response.length} bytes, devices=${wifiBssids.length || 1}`);
    
    $done({
        response: {
            status: 200,
            headers: {
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-cache, no-store"
            },
            bodyBytes: response.buffer
        }
    });
})();
