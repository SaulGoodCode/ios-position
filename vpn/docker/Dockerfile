# ============================================================
# Dockerfile - strongSwan IKEv2 VPN Server
# For running inside VMware Linux
# ============================================================
FROM alpine:3.19

RUN apk add --no-cache \
    strongswan \
    strongswan-charon \
    strongswan-swanctl \
    strongswan-pki \
    iptables \
    bash \
    openssl \
    curl

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# strongSwan config directories
RUN mkdir -p /etc/ipsec.d/cacerts \
             /etc/ipsec.d/certs \
             /etc/ipsec.d/private \
             /etc/ipsec.d/aacerts \
             /data

EXPOSE 500/udp 4500/udp

VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]
