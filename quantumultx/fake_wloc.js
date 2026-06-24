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
 * 
 * BoxJS 订阅（在 BoxJS Web 界面中修改经纬度，无需编辑脚本）：
 *   https://raw.githubusercontent.com/SaulGoodCode/ios-position/main/quantumultx/boxjs.json
 */

// ============================================================
// 配置区 — 默认值（可通过 BoxJS Web 界面覆盖）
//
// 常用坐标参考：
//   北京天安门:  39.9042,  116.4074
//   上海外滩:    31.2304,  121.4737
//   深圳南山:    22.5431,  114.0579
//   香港中环:    22.3193,  114.1694
//   东京塔:      35.6762,  139.6503
//   纽约时代广场: 40.7580,  -73.9855
// ============================================================
let SPOOF_LAT = 39.9042;
let SPOOF_LNG = 116.4074;
let SPOOF_LABEL = "Beijing";
let GCJ02_ENABLED = true; // GCJ-02→WGS-84 转换（中国区默认开启）

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
    
    // 读取 GCJ-02 转换开关（默认开启，中国区坐标自动转 WGS-84）
    const gcj = readSetting("locspoof_gcj02");
    if (gcj === "false" || gcj === "0") GCJ02_ENABLED = false;
    
    console.log(`[LocSpoof] Settings: lat=${SPOOF_LAT}, lng=${SPOOF_LNG} (${SPOOF_LABEL}), gcj02=${GCJ02_ENABLED}`);
} catch (e) {
    console.log(`[LocSpoof] Settings error: ${e.message}, using defaults`);
}

// ============================================================
// GCJ-02 → WGS-84 坐标转换（修复中国区 ~300-500m 偏差）
//
// 中国地图（高德/百度/腾讯）使用 GCJ-02 加密坐标系，
// Apple wloc 使用 WGS-84。如果从中国地图拾取坐标直接用，
// 会有 300-500 米偏移。此函数将 GCJ-02 坐标转为 WGS-84。
// ============================================================

function gcj02ToWgs84(lat, lng) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    const PI = Math.PI;
    
    // 判断是否在中国境内（粗略范围）
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) {
        return [lat, lng]; // 国外坐标不转换
    }
    
    function transformLat(x, y) {
        let ret = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
        ret += (20.0*Math.sin(6.0*x*PI) + 20.0*Math.sin(2.0*x*PI)) * 2.0 / 3.0;
        ret += (20.0*Math.sin(y*PI) + 40.0*Math.sin(y/3.0*PI)) * 2.0 / 3.0;
        ret += (160.0*Math.sin(y/12.0*PI) + 320*Math.sin(y*PI/30.0)) * 2.0 / 3.0;
        return ret;
    }
    
    function transformLng(x, y) {
        let ret = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
        ret += (20.0*Math.sin(6.0*x*PI) + 20.0*Math.sin(2.0*x*PI)) * 2.0 / 3.0;
        ret += (20.0*Math.sin(x*PI) + 40.0*Math.sin(x/3.0*PI)) * 2.0 / 3.0;
        ret += (150.0*Math.sin(x/12.0*PI) + 300.0*Math.sin(x/30.0*PI)) * 2.0 / 3.0;
        return ret;
    }
    
    let dlat = transformLat(lng - 105.0, lat - 35.0);
    let dlng = transformLng(lng - 105.0, lat - 35.0);
    const radlat = lat / 180.0 * PI;
    let magic = Math.sin(radlat);
    magic = 1 - ee * magic * magic;
    const sqrtmagic = Math.sqrt(magic);
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * PI);
    dlng = (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * PI);
    return [lat - dlat, lng - dlng];
}

// 应用 GCJ-02 → WGS-84 转换
if (GCJ02_ENABLED) {
    const [wgsLat, wgsLng] = gcj02ToWgs84(SPOOF_LAT, SPOOF_LNG);
    console.log(`[LocSpoof] GCJ-02→WGS-84: (${SPOOF_LAT},${SPOOF_LNG}) → (${wgsLat.toFixed(6)},${wgsLng.toFixed(6)})`);
    SPOOF_LAT = wgsLat;
    SPOOF_LNG = wgsLng;
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

// 检查一段字节是否像 CellTower（field 1=MCC, field 2=MNC, field 5=Location bytes）
function looksLikeCellTower(data, start, end) {
    let offset = start;
    let hasMcc = false, hasMnc = false, hasLocBytes = false;
    try {
        while (offset < end) {
            const [tagVal, tagEnd] = readVarint(data, offset);
            const fn = (tagVal >>> 3);
            const wt = tagVal & 7;
            offset = tagEnd;

            if (fn === 1 && wt === 0) {
                const [v, o] = readVarint(data, offset);
                offset = o;
                if (v >= 1 && v <= 999) hasMcc = true; // MCC range
                else return false;
            } else if (fn === 2 && wt === 0) {
                const [v, o] = readVarint(data, offset);
                offset = o;
                if (v >= 0 && v <= 999) hasMnc = true; // MNC range
                else return false;
            } else if (fn === 5 && wt === 2) {
                const [len, lenEnd] = readVarint(data, offset);
                offset = lenEnd;
                if (len >= 10 && len <= 60 && offset + len <= end) hasLocBytes = true;
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
        }
    } catch (e) {
        return false;
    }
    return hasMcc && hasMnc && hasLocBytes;
}

// 修改 CellTower 子消息中 field 5 (Location bytes) 内的 lat/lng
function patchCellTower(data, start, end) {
    let offset = start;
    while (offset < end) {
        const [tagVal, tagEnd] = readVarint(data, offset);
        const fieldNumber = (tagVal >>> 3);
        const wireType = tagVal & 7;
        offset = tagEnd;

        if (wireType === 2) {
            const [length, lenEnd] = readVarint(data, offset);
            offset = lenEnd;
            const fieldEnd = offset + length;
            if (fieldNumber === 5) { // Location sub-message
                const patched = patchLocation(data, offset, fieldEnd);
                return patched >= 2 ? 1 : 0;
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
    return 0;
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
            } else if (fieldNumber === 24 && looksLikeCellTower(data, offset, fieldEnd)) {
                // 确认是 CellTower
                deviceCount += patchCellTower(data, offset, fieldEnd);
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
    let wifiCount = 0;
    let cellCount = 0;
    const topLevelFields = [];
    
    // 第一遍：遍历所有顶层字段，记录结构并尝试 patch WiFi (f2) 和 Cell (f24)
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
                wifiCount += patchWifiDevice(data, offset, fieldEnd);
            } else if (fieldNumber === 24 && looksLikeCellTower(data, offset, fieldEnd)) {
                cellCount += patchCellTower(data, offset, fieldEnd);
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
    
    let deviceCount = wifiCount + cellCount;
    console.log(`[LocSpoof] Top-level fields: ${topLevelFields.slice(0, 15).join(", ")}${topLevelFields.length > 15 ? "..." : ""}`);
    console.log(`[LocSpoof] Direct patch: ${wifiCount} WiFi + ${cellCount} Cell = ${deviceCount}`);
    
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
