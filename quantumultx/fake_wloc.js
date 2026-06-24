/**
 * fake_wloc.js — Quantumult X 脚本 (script-response-body)
 *
 * 【修复版】完全重建 AppleWLoc protobuf 响应（参照后端 apple_wloc.py）
 *
 * 工作原理：
 *   1. iPhone 发送 WiFi BSSID 请求到 Apple (gs-loc.apple.com)
 *   2. Apple 返回对应 BSSID 的真实坐标（ARPC + Protobuf 格式）
 *   3. 本脚本拦截 Apple 的响应，解析出所有 BSSID 列表
 *   4. 完全重建 AppleWLoc protobuf：每个 BSSID 都指向同一假坐标
 *   5. 追加 num_cell_results = -1，彻底禁用基站定位结果
 *   6. 重新封装为 ARPC 响应返回给 iPhone
 *
 * 修复了旧"原地修改"方案的 3 大漂移源：
 *   ① CellTower 基站坐标未改 → 重建响应直接不输出 CellTower
 *   ② varint 字节长度约束导致部分 BSSID 改不动 → 重建时按需分配字节
 *   ③ num_cell_results 未清零 → 显式设为 -1 让 iOS 忽略基站结果
 *
 * Quantumult X 配置：
 *   [rewrite_local]
 *   ^https://gs-loc(-cn)?\.apple\.com/clls/wloc url script-response-body fake_wloc.js
 *
 *   [mitm]
 *   hostname = gs-loc.apple.com, gs-loc-cn.apple.com
 *
 * BoxJS 订阅：
 *   https://raw.githubusercontent.com/SaulGoodCode/ios-position/main/quantumultx/boxjs.json
 */

// ============================================================
// 配置区 — 默认值（可通过 BoxJS Web 界面覆盖）
// ============================================================
let SPOOF_LAT = 39.9042;
let SPOOF_LNG = 116.4074;
let SPOOF_LABEL = "Beijing";

try {
    const readSetting = (key) => {
        if (typeof $prefs !== "undefined" && $prefs.valueForKey) {
            const v = $prefs.valueForKey(key);
            if (v) return v;
        }
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
// Protobuf wire 常量
// ============================================================
const VARINT = 0;
const LENGTH_DELIMITED = 2;
const COORD_SCALE = 100000000; // Apple 用 1e8 缩放坐标

function coordToInt(coord) {
    return Math.round(coord * COORD_SCALE);
}

// ============================================================
// Protobuf 编码器（输出 number 数组，便于拼接）
// ============================================================
function encodeVarint(value) {
    const bytes = [];
    // Apple 坐标值都是正数（lat * 1e8 最大 9e9 < 2^34，JS 安全范围内）
    // sint32 zigzag 后也是正数
    if (value < 0) {
        // 极少使用：负 int64 → 10 字节 2 补码
        value = value + Math.pow(2, 64);
    }
    while (value > 0x7F) {
        bytes.push((value & 0x7F) | 0x80);
        value = Math.floor(value / 128);
    }
    bytes.push(value & 0x7F);
    return bytes;
}

function encodeTag(fieldNumber, wireType) {
    return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeVarintField(fieldNumber, value) {
    if (value === 0) return []; // proto3 默认值省略
    return encodeTag(fieldNumber, VARINT).concat(encodeVarint(value));
}

// sint32 zigzag: (n << 1) ^ (n >> 31)
function encodeSint32Field(fieldNumber, value) {
    if (value === 0) return [];
    const zigzag = ((value << 1) ^ (value >> 31)) >>> 0; // 无符号 32 位
    return encodeTag(fieldNumber, VARINT).concat(encodeVarint(zigzag));
}

function encodeBytesField(fieldNumber, valueBytes) {
    if (!valueBytes || valueBytes.length === 0) return [];
    return encodeTag(fieldNumber, LENGTH_DELIMITED)
        .concat(encodeVarint(valueBytes.length))
        .concat(valueBytes);
}

function encodeStringField(fieldNumber, str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        bytes.push(str.charCodeAt(i) & 0xFF);
    }
    return encodeBytesField(fieldNumber, bytes);
}

// ============================================================
// AppleWLoc 消息构建器（对应后端 apple_wloc.py）
// ============================================================

// Location {
//   int64 latitude  = 1;   // coord * 1e8
//   int64 longitude = 2;
//   int64 horizontal_accuracy = 3;
//   int64 altitude  = 5;
//   int64 vertical_accuracy = 6;
// }
function buildLocation(lat, lng, hAcc, vAcc) {
    const buf = [];
    const latInt = coordToInt(lat);
    const lngInt = coordToInt(lng);
    if (latInt !== 0) buf.push.apply(buf, encodeVarintField(1, latInt));
    if (lngInt !== 0) buf.push.apply(buf, encodeVarintField(2, lngInt));
    if (hAcc && hAcc !== 0) buf.push.apply(buf, encodeVarintField(3, hAcc));
    if (vAcc && vAcc !== 0) buf.push.apply(buf, encodeVarintField(6, vAcc));
    return buf;
}

// WifiDevice {
//   string bssid = 1;
//   Location location = 2;
// }
function buildWifiDevice(bssid, locBytes) {
    const buf = [];
    buf.push.apply(buf, encodeStringField(1, bssid));
    if (locBytes && locBytes.length > 0) {
        buf.push.apply(buf, encodeBytesField(2, locBytes));
    }
    return buf;
}

// AppleWLoc {
//   repeated WifiDevice wifi_devices = 2;
//   sint32 num_cell_results = 3;     // 设 -1 禁用基站
//   ...
// }
function buildAppleWlocResponse(lat, lng, bssidList) {
    const buf = [];
    const loc = buildLocation(lat, lng, 65, 10);

    // Field 2: wifi_devices (repeated)
    for (let i = 0; i < bssidList.length; i++) {
        const wd = buildWifiDevice(bssidList[i], loc);
        buf.push.apply(buf, encodeBytesField(2, wd));
    }

    // Field 3: num_cell_results = -1 (彻底禁用基站结果)
    buf.push.apply(buf, encodeSint32Field(3, -1));

    return buf;
}

// ============================================================
// Apple 原始响应解析 — 提取所有 BSSID
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
        if (bytesRead > 10) break;
    }
    return [result, offset];
}

// 检测某段字节是否符合 BSSID 字符串格式：XX:XX:XX:XX:XX:XX
function isBssidLike(data, start, len) {
    if (len < 11 || len > 22) return false;
    let colons = 0;
    for (let i = 0; i < len; i++) {
        const c = data[start + i];
        if (c === 0x3A) {
            colons++;
        } else if (!((c >= 0x30 && c <= 0x39) ||
                     (c >= 0x41 && c <= 0x46) ||
                     (c >= 0x61 && c <= 0x66))) {
            return false;
        }
    }
    return colons === 5;
}

function bytesToString(data, start, len) {
    let s = "";
    for (let i = 0; i < len; i++) {
        s += String.fromCharCode(data[start + i]);
    }
    return s;
}

// 递归扫描 protobuf 找出所有 BSSID 字符串（field 1, length-delimited）
function extractAllBssids(data, start, end) {
    const bssids = [];
    const seen = Object.create(null);

    function scan(s, e, depth) {
        if (depth > 5 || s >= e) return;
        let offset = s;
        while (offset < e) {
            let tagVal, tagEnd;
            try {
                [tagVal, tagEnd] = readVarint(data, offset);
            } catch (err) {
                return;
            }
            const fn = tagVal >>> 3;
            const wt = tagVal & 7;
            offset = tagEnd;

            if (wt === LENGTH_DELIMITED) {
                let len, lenEnd;
                try {
                    [len, lenEnd] = readVarint(data, offset);
                } catch (err) {
                    return;
                }
                offset = lenEnd;
                const fieldEnd = offset + len;
                if (fieldEnd > e || fieldEnd < offset) return;

                // field 1 + BSSID 格式 = 命中
                if (fn === 1 && isBssidLike(data, offset, len)) {
                    const s = bytesToString(data, offset, len);
                    if (!seen[s]) {
                        seen[s] = true;
                        bssids.push(s);
                    }
                } else if (len >= 6) {
                    // 否则递归进入子消息继续找
                    scan(offset, fieldEnd, depth + 1);
                }
                offset = fieldEnd;
            } else if (wt === VARINT) {
                let _; [_, offset] = readVarint(data, offset);
            } else if (wt === 1) {
                offset += 8;
            } else if (wt === 5) {
                offset += 4;
            } else {
                return;
            }
        }
    }

    scan(start, end, 0);
    return bssids;
}

// ============================================================
// 主逻辑 — 完全重建响应
// ============================================================
(function main() {
    let rawBytes = null;

    if (typeof $response !== "undefined") {
        if ($response.bodyBytes && $response.bodyBytes.byteLength > 0) {
            rawBytes = new Uint8Array($response.bodyBytes);
        } else if ($response.body && $response.body.length > 0) {
            const str = $response.body;
            rawBytes = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) {
                rawBytes[i] = str.charCodeAt(i) & 0xFF;
            }
        }
    }

    if (!rawBytes || rawBytes.length <= 10) {
        console.log("[LocSpoof] No/short response body, passthrough");
        $done({});
        return;
    }

    const headHex = Array.from(rawBytes.slice(0, 12))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[LocSpoof] Original header: ${headHex}, size: ${rawBytes.length}B`);

    // ARPC 响应头: [8 字节 prefix][2 字节 uint16 BE length][protobuf...]
    // 标准 prefix: 00 01 00 00 00 01 00 00
    let protobufStart = 10;
    if (rawBytes[0] !== 0x00 || rawBytes[1] !== 0x01) {
        // 非标准前缀：扫描找第一个有效 protobuf tag
        for (let i = 0; i < Math.min(30, rawBytes.length); i++) {
            const wt = rawBytes[i] & 0x07;
            const fn = rawBytes[i] >>> 3;
            if ((wt === 0 || wt === 2) && fn >= 1 && fn <= 10) {
                protobufStart = i;
                break;
            }
        }
    }

    // 1. 解析 Apple 响应取 BSSID 列表
    const bssids = extractAllBssids(rawBytes, protobufStart, rawBytes.length);
    console.log(`[LocSpoof] Extracted ${bssids.length} BSSIDs from Apple response`);

    if (bssids.length === 0) {
        bssids.push("00:00:00:00:00:00");
    }
    // 调试输出前 3 个
    for (let i = 0; i < Math.min(3, bssids.length); i++) {
        console.log(`  [${i}] ${bssids[i]}`);
    }

    // 2. 完全重建 AppleWLoc protobuf
    const newProtobuf = buildAppleWlocResponse(SPOOF_LAT, SPOOF_LNG, bssids);

    // 3. 重新封装 ARPC 响应
    const newResponse = new Uint8Array(protobufStart + newProtobuf.length);

    // 复制原始 ARPC 头前 8 字节（prefix 不变）
    const headerCopyLen = Math.min(protobufStart, 8);
    for (let i = 0; i < headerCopyLen; i++) {
        newResponse[i] = rawBytes[i];
    }
    // 若是标准 10 字节头，重写 bytes [8..10) 为新 payload length (uint16 BE)
    if (protobufStart >= 10) {
        const len16 = newProtobuf.length & 0xFFFF;
        newResponse[8] = (len16 >>> 8) & 0xFF;
        newResponse[9] = len16 & 0xFF;
    }
    // 拷贝新 protobuf
    for (let i = 0; i < newProtobuf.length; i++) {
        newResponse[protobufStart + i] = newProtobuf[i];
    }

    console.log(`[LocSpoof] Rebuilt: ${newResponse.length}B ` +
                `(protobuf=${newProtobuf.length}B, devices=${bssids.length}) ` +
                `→ ${SPOOF_LAT}, ${SPOOF_LNG} (${SPOOF_LABEL})`);

    $done({ bodyBytes: newResponse.buffer });
})();
