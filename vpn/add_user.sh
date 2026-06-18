#!/bin/bash
# ============================================================
# Add VPN user to strongSwan
# Usage: ./add_user.sh <username> <password>
# ============================================================

set -e

USERNAME="${1:?Usage: $0 <username> <password>}"
PASSWORD="${2:?Usage: $0 <username> <password>}"

echo "[+] Adding VPN user: $USERNAME"

# Add to ipsec.secrets
echo "$USERNAME : EAP \"$PASSWORD\"" >> /etc/ipsec.secrets

# Reload strongSwan config
ipsec reload

echo "[+] User added successfully."
echo "    Username: $USERNAME"
echo "    Password: $PASSWORD"
