/**
 * 
 * Quantumult X 配置：
 *   [rewrite_local]
 *   ^https://gs-loc(-cn)?\.apple\.com/clls/wloc url script-response-body fake_wloc.js
 *   
 *   [mitm]
 *   hostname = gs-loc.apple.com, gs-loc-cn.apple.com
 * 
 * BoxJS 订阅（在 BoxJS Web 界面中修改经纬度，无需编辑脚本）：
 *   https://raw.githubusercontent.com/SaulGoodCode/ios-position/main/quantumultx/boxjs.json
 */

let SPOOF_LAT = 39.9042;
let SPOOF_LNG = 116.4074;
let SPOOF_LABEL = "Beijing";

// 从 BoxJS / 持久化存储读取用户设置
try {
    let readSetting = (key) => {
        // QX: $prefs.valueForKey (已验证可用)
        if (typeof $prefs !== "undefined" && $prefs.valueForKey) {
            const v = $prefs.valueForKey(key);
            if (v) return v;
        }
        // Surge/Loon: $persistentStore
        if (typeof $persistentStore !== "undefined" && $persistentStore.read) {
            return $persistentStore.read(key);
        }
        return null;
    };
    
    const sl = readSetting("locspoof_lat");
    const sn = readSetting("locspoof_lng");
    const lb = readSetting("locspoof_label");
    
    if (sl) { const v = parseFloat(sl); if (!isNaN(v) && v >= -90 && v <= 90) SPOOF_LAT = v; }
    if (sn) { const v = parseFloat(sn); if (!isNaN(v) && v >= -180 && v <= 180) SPOOF_LNG = v; }
    if (lb) SPOOF_LABEL = lb;
    
    console.log(`[LocSpoof] Settings: lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL})`);
} catch (e) {
    console.log(`[LocSpoof] Settings error: ${e.message}, using defaults`);
}

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

// 检查一段字节是否像 WifiDevice（field 1 = BSSID 格式字符串）
function looksLikeWifiDevice(data, start, end) {
    let offset = start;
    while (offset < end) {
        try {
            const [tagVal, tagEnd] = readVarint(data, offset);
            const fn = (tagVal >>> 3);
            const wt = tagVal & 7;
            offset = tagEnd;
            
            if (fn === 1 && wt === 2) {
                const [len, lenEnd] = readVarint(data, offset);
                offset = lenEnd;
                if (len >= 11 && len <= 22 && offset + len <= end) {
                    // 检查 BSSID 格式: XX:XX:XX:XX:XX:XX
                    let colons = 0;
                    for (let i = 0; i < len; i++) {
                        if (data[offset + i] === 0x3A) colons++;
                    }
                    if (colons === 5) return true;
                }
                offset += len;
            } else if (wt === 0) {
                const [, o] = readVarint(data, offset);
                offset = o;
            } else if (wt === 2) {
                const [len, lenEnd] = readVarint(data, offset);
                offset = lenEnd + len;
            } else if (wt === 1) {
                offset += 8;
            } else if (wt === 5) {
                offset += 4;
            } else {
                return false;
            }
        } catch (e) {
            return false;
        }
    }
    return false;
}

// 递归搜索并修改包含 WifiDevice 的子消息
function patchRecursive(data, start, end, depth, label) {
    if (depth > 3 || start >= end) return 0;
    
    let offset = start;
    let deviceCount = 0;
    
    while (offset < end) {
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;
        
        if (wireType === 2) {
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd;
            const fieldEnd = offset + length;
            
            if (fieldEnd > end || fieldEnd < offset) break;
            
            if (fieldNumber === 2 && looksLikeWifiDevice(data, offset, fieldEnd)) {
                // 确认是 WifiDevice
                deviceCount += patchWifiDevice(data, offset, fieldEnd);
            } else if (length > 20) {
                // 不是 WifiDevice，递归搜索嵌套结构
                const found = patchRecursive(data, offset, fieldEnd, depth + 1,
                    `${label}.${fieldNumber}`);
                deviceCount += found;
            }
            offset = fieldEnd;
        } else if (wireType === 0) {
            const [, o] = readVarint(data, offset);
            offset = o;
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
// 遍历 protobuf 并修改所有 WifiDevice 坐标
// 先尝试顶层 field 2，失败则递归搜索嵌套字段
// ============================================================
function patchAllDevices(data, protobufStart, protobufEnd) {
    let offset = protobufStart;
    let deviceCount = 0;
    const topLevelFields = [];
    
    // 第一遍：遍历所有顶层字段，记录结构并尝试 patch field 2
    while (offset < protobufEnd) {
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;
        
        if (wireType === 2) {
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd;
            const fieldEnd = offset + length;
            
            if (fieldEnd > protobufEnd) break;
            
            topLevelFields.push(`f${fieldNumber}(${length}B)`);
            
            if (fieldNumber === 2 && looksLikeWifiDevice(data, offset, fieldEnd)) {
                deviceCount += patchWifiDevice(data, offset, fieldEnd);
            }
            offset = fieldEnd;
        } else if (wireType === 0) {
            const [val, o] = readVarint(data, offset);
            topLevelFields.push(`f${fieldNumber}=${val}`);
            offset = o;
        } else if (wireType === 1) {
            topLevelFields.push(`f${fieldNumber}(64bit)`);
            offset += 8;
        } else if (wireType === 5) {
            topLevelFields.push(`f${fieldNumber}(32bit)`);
            offset += 4;
        } else {
            break;
        }
    }
    
    console.log(`[LocSpoof] Top-level fields: ${topLevelFields.slice(0, 15).join(", ")}${topLevelFields.length > 15 ? "..." : ""}`);
    console.log(`[LocSpoof] Direct field 2 patch: ${deviceCount} devices`);
    
    // 如果顶层没找到 WifiDevice，递归搜索嵌套字段
    if (deviceCount === 0) {
        console.log("[LocSpoof] No WifiDevice at top level, searching nested...");
        offset = protobufStart;
        while (offset < protobufEnd) {
            const [tagVal, tagEnd] = readVarint(data, offset);
            const wireType = tagVal & 7;
            offset = tagEnd;
            
            if (wireType === 2) {
                const [length, lenEnd] = readVarint(data, offset);
                offset = lenEnd;
                const fieldEnd = offset + length;
                if (fieldEnd > protobufEnd) break;
                
                deviceCount += patchRecursive(data, offset, fieldEnd, 1, `top`);
                offset = fieldEnd;
            } else if (wireType === 0) {
                const [, o] = readVarint(data, offset);
                offset = o;
            } else if (wireType === 1) {
                offset += 8;
            } else if (wireType === 5) {
                offset += 4;
            } else {
                break;
            }
        }
        console.log(`[LocSpoof] Recursive search: ${deviceCount} devices`);
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
