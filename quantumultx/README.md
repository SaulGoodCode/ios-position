# LocSpoof — Quantumult X 方案

> 无需服务器、无需 VPN，在 iPhone 本地通过 Quantumult X 的 MITM + 脚本引擎拦截
> Apple Wi-Fi 定位请求，返回伪造坐标。

## 原理

iPhone 在 GPS 不可用时会请求 `gs-loc.apple.com/clls/wloc`（Apple Wi-Fi 定位服务），
发送周围 WiFi 的 BSSID，Apple 返回基于其数据库的坐标。

Quantumult X 开启 MITM 后可以解密这个 HTTPS 请求，
用 `script-response-body` 类型的脚本直接拦截并返回伪造的 protobuf 响应。

```
iPhone → Quantumult X (本地 VPN) → 检测到 gs-loc.apple.com
    ↓ MITM 解密
    ↓ 请求转发给 Apple，Apple 返回真实 ARPC/Protobuf 响应
    ↓ 脚本拦截响应，原地修改其中所有 WifiDevice 的经纬度坐标
    ↓ 返回修改后的响应（保留完整 Apple 响应结构）
    ↓
CoreLocation 收到假坐标 → 全系统生效
```

## 前提条件

1. iPhone 已安装 **Quantumult X**
2. Quantumult X 的 **CA 证书已安装并在系统设置中信任**
   - 设置 → 通用 → VPN 与设备管理 → 安装 QX CA
   - 设置 → 通用 → 关于本机 → 证书信任设置 → 打开开关
3. Wi-Fi 开关打开（不需要连接任何网络，只需要开着让 iPhone 能扫描 AP）
4. GPS 信号不可用（室内），或手动清除 GPS 缓存

## 安装步骤

### 方法一：本地脚本（推荐）

1. 将 `fake_wloc.js` 复制到 iPhone 上：
   - 通过 iCloud Drive → `Quantumult X/Scripts/` 目录
   - 或通过 AirDrop / 文件 App

2. 编辑 Quantumult X 配置，在对应段添加：

```ini
[rewrite_local]
^https://gs-loc\.apple\.com/clls/wloc url script-response-body fake_wloc.js
^https://gs-loc-cn\.apple\.com/clls/wloc url script-response-body fake_wloc.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com
```

3. 保存配置，确保 Quantumult X 的 **重写 (Rewrite)** 和 **MITM** 都已开启

### 方法二：远程脚本

如果你把代码 push 到 GitHub：

```ini
[rewrite_local]
^https://gs-loc\.apple\.com/clls/wloc url script-response-body https://raw.githubusercontent.com/你的用户名/ios-locspoof/main/quantumultx/fake_wloc.js
^https://gs-loc-cn\.apple\.com/clls/wloc url script-response-body https://raw.githubusercontent.com/你的用户名/ios-locspoof/main/quantumultx/fake_wloc.js

[mitm]
hostname = gs-loc.apple.com, gs-loc-cn.apple.com
```

## 修改伪造坐标

### 方法一：BoxJS Web 界面（推荐）

1. 安装 [BoxJS](https://github.com/chavyleung/boxjs)（如未安装，可在 QX 中添加 BoxJS 的 rewrite 规则）
2. 在 BoxJS 中订阅本脚本：
   ```
   https://raw.githubusercontent.com/SaulGoodCode/ios-position/main/quantumultx/fake_wloc.js
   ```
3. 打开 BoxJS Web 界面（通常是 `http://boxjs.com`），进入「iOS 定位伪造」面板
4. 修改纬度、经度、标签，保存后**立即生效**（下次定位请求自动使用新坐标）

### 方法二：直接编辑脚本

编辑 `fake_wloc.js` 顶部的配置区：

```javascript
let SPOOF_LAT = 39.9042;      // 纬度（北京天安门）
let SPOOF_LNG = 116.4074;     // 经度
let SPOOF_LABEL = "Beijing";  // 标签（仅日志用）
```

改完保存后，Quantumult X 会自动加载新版本（本地脚本即时生效，远程脚本需要手动更新或改 `?v=N`）。

## 触发虚拟定位

1. 确保 Quantumult X 已连接（状态栏有 VPN 图标）
2. **设置 → 隐私与安全 → 定位服务** → 关闭，等 5 秒，再打开
3. 立刻打开「地图」App，点右上角定位箭头
4. 定位将显示为伪造坐标

> **注意**：如果在室外 GPS 信号好的地方，iPhone 会在 10-30 秒内切回真实 GPS 位置。
> 此方案最适合在室内使用（GPS 不可用的环境）。

## 调试

在 Quantumult X 中查看日志：

- 工具 → 最近请求 → 搜索 `gs-loc`
- 应该能看到请求被脚本处理（显示脚本图标）
- 控制台日志会输出 `[LocSpoof] Spoofing → lat=..., lng=...`

如果定位没变：
1. 检查 MITM 是否开启、hostname 是否正确
2. 检查 Rewrite 是否开启
3. 检查 CA 证书是否已信任
4. 确认已清除 GPS 缓存（关再开定位服务）
5. 在「最近请求」中确认 `gs-loc.apple.com` 的请求确实被脚本拦截

## 对比 VPN 方案

| | IKEv2 VPN + 服务器 | Quantumult X (本方案) |
|---|---|---|
| 需要服务器 | 是 | **不需要** |
| 部署复杂度 | Docker 3 容器 | 一个 JS 文件 |
| 全流量走隧道 | 是 | 否，只处理定位域名 |
| 网速影响 | 有 | **无** |
| 改坐标方式 | API 调用 | BoxJS Web 界面 / 改脚本 |
| 局限 | 同样受 GPS 信号限制 | 同样受 GPS 信号限制 |

## 文件说明

```
quantumultx/
├── fake_wloc.js        # 核心脚本 — ARPC/Protobuf 编解码 + 伪造响应
├── quantumultx.conf    # 配置片段 — 复制到你的 QX 配置中
└── README.md           # 本文件
```
