use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::http::HeaderMap;

#[derive(Clone, Copy)]
pub struct ClientIp(pub IpAddr);

/// Resolve the client IP. Forwarding headers are only trusted when the direct
/// peer is loopback (the local reverse proxy case); otherwise a remote client
/// could spoof `X-Forwarded-For` and bypass the LAN-only restriction.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    if peer.ip().is_loopback() {
        if let Some(ip) = forwarded_ip(headers) {
            return ip;
        }
    }
    normalize(peer.ip())
}

fn forwarded_ip(headers: &HeaderMap) -> Option<IpAddr> {
    for name in ["x-forwarded-for", "x-real-ip"] {
        let Some(raw) = headers.get(name).and_then(|value| value.to_str().ok()) else {
            continue;
        };
        let first = raw.split(',').next()?.trim().trim_matches('"');
        if let Ok(ip) = first.parse::<IpAddr>() {
            return Some(normalize(ip));
        }
        if let Ok(addr) = first.parse::<SocketAddr>() {
            return Some(normalize(addr.ip()));
        }
    }
    None
}

pub fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        IpAddr::V4(v4) => IpAddr::V4(v4),
    }
}

/// Loopback, RFC1918, link-local, IPv6 ULA and CGNAT/Tailscale ranges.
pub fn is_internal(ip: IpAddr) -> bool {
    match normalize(ip) {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || is_cgnat(v4)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local()
        }
    }
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0b1100_0000) == 64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ranges_are_internal() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.2",
            "169.254.1.1",
            "100.64.0.1",
            "100.127.255.254",
            "::1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(is_internal(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn public_ranges_are_external() {
        for ip in ["8.8.8.8", "1.1.1.1", "223.5.5.5", "2001:4860:4860::8888"] {
            assert!(!is_internal(ip.parse().unwrap()), "{ip}");
        }
        assert!(!is_internal("100.63.255.255".parse().unwrap()));
        assert!(!is_internal("100.128.0.0".parse().unwrap()));
    }

    #[test]
    fn ipv4_mapped_ipv6_is_normalized() {
        let ip: IpAddr = "::ffff:192.168.1.10".parse().unwrap();
        assert!(is_internal(ip));
    }
}
