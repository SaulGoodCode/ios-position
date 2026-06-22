/**
 * fake_wloc.js — Quantumult X 脚本 (script-response-body)
 * 
 * 工作原理：
 *   1. iPhone 发送 WiFi BSSID 请求到 Apple (gs-loc.apple.com)
 *   2. Apple 返回对应 BSSID 的真实坐标（ARPC + Protobuf 格式）
 *   3. 本脚本拦截 Apple 的响应，直接在原始二进制中修改坐标值
 *   4. 保留 Apple 响应的完整结构（所有字段不变），仅替换 lat/lng
 *   5. 返回修改后的原始响应给 iPhone
 *   
 *   iPhone 看到完整的 Apple 格式响应 + 坐标全指向同一假位置 → 采信
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

// ============================================================
// Apple 坐标编码：经纬度 × 10^8 → int64
// ============================================================
const COORD_SCALE = 100000000;

function coordToInt(coord) {
    return Math.round(coord * COORD_SCALE);
}

// ============================================================
// Protobuf varint 读写
// ============================================================
function readVarint(data, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset < data.length) {
        const byte = data[offset++];
        bytesRead++;
        result += (byte & 0x7F) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (bytesRead > 10) break; // 防止无限循环
    }
    return [result, offset];
}

// 将 value 写入 data[offset] 起始的 exactLen 个字节（固定长度 varint）
// 这样不会改变总长度，不需要更新任何 length prefix
function writeVarintFixedLen(data, offset, value, exactLen) {
    for (let i = 0; i < exactLen - 1; i++) {
        data[offset + i] = (value & 0x7F) | 0x80; // 设置 continuation bit
        value = Math.floor(value / 128);
    }
    data[offset + exactLen - 1] = value & 0x7F; // 最后一个字节无 continuation
}

// 检查 value 是否能编码进 exactLen 字节的 varint
function canFitInVarint(value, numBytes) {
    // numBytes 个 varint 字节最多能表示 7*numBytes 位
    const maxVal = Math.pow(2, 7 * numBytes) - 1;
    return value >= 0 && value <= maxVal;
}

// ============================================================
// 原地修改 Location 子消息中的 lat/lng
// 
// Location 结构:
//   field 1 (varint) = latitude  (coord × 10^8)
//   field 2 (varint) = longitude (coord × 10^8)
//   field 3+ = accuracy 等其他字段（保持不变）
// ============================================================
function patchLocation(data, start, end) {
    let offset = start;
    let patched = 0;
    
    while (offset < end) {
        const tagStart = offset;
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;
        
        if (wireType === 0) { // varint
            const varintStart = offset;
            const [originalValue, varintEnd] = readVarint(data, offset);
            const varintLen = varintEnd - varintStart;
            
            if (fieldNumber === 1) { // latitude
                const newVal = coordToInt(SPOOF_LAT);
                if (canFitInVarint(newVal, varintLen)) {
                    writeVarintFixedLen(data, varintStart, newVal, varintLen);
                    patched++;
                }
            } else if (fieldNumber === 2) { // longitude
                const newVal = coordToInt(SPOOF_LNG);
                if (canFitInVarint(newVal, varintLen)) {
                    writeVarintFixedLen(data, varintStart, newVal, varintLen);
                    patched++;
                }
            }
            offset = varintEnd;
        } else if (wireType === 2) { // length-delimited
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd + length;
        } else if (wireType === 1) { // 64-bit
            offset += 8;
        } else if (wireType === 5) { // 32-bit
            offset += 4;
        } else {
            break;
        }
        
        if (patched >= 2) break; // lat + lng 都改完了
    }
    return patched;
}

// ============================================================
// 在 WifiDevice 子消息中找到 Location (field 2) 并修改
// 
// WifiDevice 结构:
//   field 1 (bytes/string) = BSSID
//   field 2 (sub-message) = Location
//   field 3+ = 其他字段（保持不变）
// ============================================================
function patchWifiDevice(data, start, end) {
    let offset = start;
    
    while (offset < end) {
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;
        
        if (wireType === 2) { // length-delimited
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd;
            const fieldEnd = offset + length;
            
            if (fieldNumber === 2) { // Location sub-message
                const patched = patchLocation(data, offset, fieldEnd);
                return patched >= 2 ? 1 : 0;
            }
            offset = fieldEnd;
        } else if (wireType === 0) {
            const [, end2] = readVarint(data, offset);
            offset = end2;
        } else if (wireType === 1) {
            offset += 8;
        } else if (wireType === 5) {
            offset += 4;
        } else {
            break;
        }
    }
    return 0;
}

// ============================================================
// 遍历顶层 protobuf，找所有 WifiDevice (field 2) 并修改坐标
// ============================================================
function patchAllDevices(data, protobufStart, protobufEnd) {
    let offset = protobufStart;
    let deviceCount = 0;
    
    while (offset < protobufEnd) {
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;
        
        if (wireType === 2) { // length-delimited
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd;
            const fieldEnd = offset + length;
            
            if (fieldNumber === 2) { // WifiDevice
                deviceCount += patchWifiDevice(data, offset, fieldEnd);
            }
            offset = fieldEnd;
        } else if (wireType === 0) {
            const [, end] = readVarint(data, offset);
            offset = end;
        } else if (wireType === 1) {
            offset += 8;
        } else if (wireType === 5) {
            offset += 4;
        } else {
            break;
        }
    }
    return deviceCount;
}

// ============================================================
// 主逻辑 — script-response-body 模式
//
// 策略：直接修改 Apple 原始响应中的坐标字节
// 不重建 protobuf，保留完整结构，只改 lat/lng varint 值
// ============================================================
(function main() {
    // 读取 Apple 的原始响应体
    let rawBytes = null;
    
    if (typeof $response !== "undefined") {
        if ($response.bodyBytes && $response.bodyBytes.byteLength > 0) {
            rawBytes = new Uint8Array($response.bodyBytes);
            console.log(`[LocSpoof] Got bodyBytes: ${rawBytes.length}B`);
        } else if ($response.body && $response.body.length > 0) {
            // 回退: body string → 逐字符取 charCode
            const str = $response.body;
            rawBytes = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) {
                rawBytes[i] = str.charCodeAt(i) & 0xFF;
            }
            console.log(`[LocSpoof] Got body string: ${rawBytes.length}B`);
        }
    }
    
    if (!rawBytes || rawBytes.length <= 10) {
        console.log("[LocSpoof] No/short response body, passthrough");
        $done({});
        return;
    }
    
    // 打印头部 hex 用于调试
    const headHex = Array.from(rawBytes.slice(0, 12)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[LocSpoof] Header: ${headHex}`);
    
    // 确定 ARPC protobuf 起始偏移
    // 标准 ARPC: [8 bytes prefix][2 bytes length][protobuf...]
    let protobufStart = 10;
    
    // 验证标准头部
    if (rawBytes[0] === 0x00 && rawBytes[1] === 0x01) {
        protobufStart = 10;
    } else {
        // 非标准头部：扫描找第一个有效 protobuf tag
        for (let i = 0; i < Math.min(30, rawBytes.length); i++) {
            const wt = rawBytes[i] & 0x07;
            const fn = rawBytes[i] >>> 3;
            if ((wt === 0 || wt === 2) && fn >= 1 && fn <= 10) {
                protobufStart = i;
                break;
            }
        }
    }
    
    // 创建可修改的副本
    const patchedBytes = new Uint8Array(rawBytes);
    
    // 原地修改所有 WifiDevice 的坐标
    const patchedCount = patchAllDevices(patchedBytes, protobufStart, patchedBytes.length);
    
    console.log(`[LocSpoof] Patched ${patchedCount} devices → lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL})`);
    console.log(`[LocSpoof] Response size unchanged: ${patchedBytes.length}B`);
    
    // 返回修改后的二进制（大小不变，结构不变，仅坐标值改变）
    $done({ bodyBytes: patchedBytes.buffer });
})();
