# iOS Location Spoofing Service

A complete implementation of iOS virtual location via VPN + MITM proxy.
Replicates the architecture of tools like loc567.com.

## Architecture

```
┌─────────────┐    VPN Tunnel    ┌──────────────────┐
│   iPhone    │ ──────────────── > │   VPN Server     │
│             │    (IKEv2)        │   (strongSwan)   │
│  ① Install  │                  │                  │
│  CA cert    │    DNS routes:   │  ② Routes        │
│  ② Install  │    gs-loc-*      │  location svc    │
│  .mobilecfg │    apple.com  ──>│  traffic to      │
│  ③ Connect  │                  │  MITM proxy      │
│  VPN        │                  └────────┬─────────┘
└─────────────┘                           │
                                          ▼
                                 ┌──────────────────┐
     ┌──────────────────┐        │   MITM Proxy     │
     │  Web Frontend    │        │   (mitmproxy)    │
     │  (Leaflet Map)   │        │                  │
     │                  │        │  ③ Intercepts    │
     │  Select location │───────>│  Apple Location  │
     │  on map          │  API   │  Service requests│
     └──────────────────┘        │  ④ Returns fake  │
              │                  │  GPS coordinates │
              ▼                  └──────────────────┘
     ┌──────────────────┐
     │  FastAPI Backend  │
     │  - Location API   │
     │  - PAC file       │
     │  - .mobileconfig  │
     │  - Device mgmt    │
     └──────────────────┘
```

## How It Works

### 1. Certificate Authority (CA)
A custom Root CA is generated and installed on the iOS device via `.mobileconfig`.
This allows the MITM proxy to forge TLS certificates for Apple's location service domains.

### 2. VPN Tunnel (IKEv2)
strongSwan runs as an IKEv2 VPN server. The `.mobileconfig` configures DNS split-tunneling
so that only traffic to `gs-loc.apple.com` and `gs-loc-cn.apple.com` is routed through the VPN.

### 3. MITM Proxy
mitmproxy intercepts HTTPS requests to Apple's Location Services, decrypts them using
the forged certificates, and returns responses containing the user's selected virtual location.

### 4. Web Frontend
A Leaflet-based map interface lets users click to select any location on the globe.
The selected coordinates are stored by the API and served to the MITM proxy.

### 5. PAC (Proxy Auto-Configuration)
A PAC file tells the iOS device to route location service traffic through the MITM proxy.

## Quick Start

### Prerequisites
- Python 3.10+
- A Linux server with root access (for VPN)
- A domain name (or use IP directly)

### Local Development

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Generate CA certificates
python scripts/generate_ca.py

# 3. Start the API server
python run.py

# 4. In another terminal, start the MITM proxy
python run.py proxy
```

Or use the shell script (Linux/macOS):
```bash
chmod +x start.sh
./start.sh
```

### Production Deployment

```bash
# 1. Set up environment variables
cp .env.example .env
# Edit .env with your domain, VPN host, credentials

# 2. Generate certificates
python scripts/generate_ca.py

# 3. Set up VPN server (on a Linux VPS)
sudo bash vpn/setup_vpn.sh

# 4. Start services with Docker
docker-compose up -d

# 5. For production with nginx
docker-compose --profile production up -d
```

### iOS Setup

1. Open Safari on iPhone, navigate to `https://your-domain/install.mobileconfig`
2. Go to Settings > tap the downloaded profile > Install
3. Go to Settings > General > About > Certificate Trust Settings > Enable the LocSpoof CA
4. Go to Settings > VPN > Enable the LocSpoof VPN
5. Open the web UI on any browser, select your virtual location, click "Apply"

## Project Structure

```
ios-locspoof/
├── config/
│   └── config.yaml              # Main configuration
├── certs/                       # Generated certificates (git-ignored)
├── data/                        # Runtime data (git-ignored)
├── backend/
│   ├── main.py                  # FastAPI application
│   ├── config.py                # Settings management
│   ├── models.py                # Pydantic models
│   ├── routes/
│   │   ├── api.py               # Location & device API
│   │   ├── pac.py               # PAC file serving
│   │   └── config_profile.py    # .mobileconfig generator
│   └── services/
│       ├── cert_manager.py      # Certificate operations
│       └── location_store.py    # Location persistence
├── proxy/
│   ├── mitm_proxy.py            # Proxy launcher
│   └── addons/
│       └── location_spoof.py    # Core interception addon
├── vpn/
│   ├── setup_vpn.sh             # strongSwan setup script
│   └── add_user.sh              # Add VPN users
├── frontend/
│   ├── index.html               # Map-based web UI
│   └── static/                  # Static assets
├── docker/
│   ├── Dockerfile.api           # API container
│   ├── Dockerfile.proxy         # Proxy container
│   └── nginx.conf               # Nginx reverse proxy
├── docker-compose.yml           # Service orchestration
├── scripts/
│   └── generate_ca.py           # CA certificate generator
├── run.py                       # Development runner
├── start.sh                     # Shell startup script
└── requirements.txt             # Python dependencies
```

## Configuration

Edit `config/config.yaml` to customize:
- Server domain and VPN host
- Intercepted domains
- VPN encryption parameters
- Default spoofed location

Edit `.env` for environment-specific settings:
- `SERVER_DOMAIN` - Your public domain
- `VPN_HOST` - VPN server address
- `VPN_USERNAME` / `VPN_PASSWORD` - VPN credentials

## Apple Location Services Protocol

The interception targets are:
- `gs-loc.apple.com` - Global location service
- `gs-loc-cn.apple.com` - China region location service

These endpoints handle WiFi/cell-tower based location lookups used by CoreLocation.
When an app requests location verification, iOS queries these services.
Our proxy returns forged coordinates instead.

**Note:** Apps that use pure GPS hardware data (bypassing CoreLocation's
network-assisted positioning) may not be affected. Most apps, however, use
the standard `CLLocationManager` which incorporates network location data.

## Security Considerations

- Keep `certs/ca.key` secure - never distribute it
- Change default VPN credentials before production use
- Use HTTPS (TLS) for the web interface in production
- The MITM proxy can only intercept domains for which it has certificates
- Consider using Let's Encrypt for the web-facing HTTPS certificates

## Troubleshooting

**VPN won't connect:**
- Check firewall allows UDP 500 and 4500
- Verify `ipsec status` shows the connection
- Check `journalctl -u strongswan -f` for errors

**Location not spoofing:**
- Verify VPN is connected on the device
- Check PAC file is accessible: `curl https://api.your-domain/proxy.pac`
- Confirm CA cert is trusted in iOS Certificate Trust Settings
- Check proxy logs for intercepted requests

**Certificate errors:**
- Ensure CA cert is installed AND trusted (Settings > About > Certificate Trust)
- Verify server certs were generated: `ls certs/`
- Regenerate if needed: `python scripts/generate_ca.py`

## License

MIT
