//! What a reverse proxy used to do for the old stack and this server now does
//! itself: work out who is really calling, and slow down password guessing.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::StatusCode;
use ipnet::IpNet;

use crate::error::ApiError;
use crate::AppState;

/// The address a request came from, looking through proxies we trust.
///
/// A proxy appends the address it received a request from to
/// `X-Forwarded-For`. Walking that list from the right and skipping trusted
/// proxies ends at the first address nobody we trust vouches for, which is
/// the client. Anything left of it was supplied by the client and is
/// ignored, so a caller cannot pick its own address.
pub fn client_address(peer: IpAddr, forwarded_for: Option<&str>, trusted: &[IpNet]) -> IpAddr {
    let is_trusted = |ip: &IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(&peer) {
        return peer;
    }
    let mut client = peer;
    for hop in forwarded_for.unwrap_or("").rsplit(',') {
        let Ok(ip) = hop.trim().parse::<IpAddr>() else {
            break;
        };
        client = ip;
        if !is_trusted(&ip) {
            break;
        }
    }
    client
}

pub struct ClientAddress(pub IpAddr);

impl FromRequestParts<AppState> for ClientAddress {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip())
            .ok_or_else(|| ApiError::internal("the peer address is not available"))?;
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok());
        Ok(Self(client_address(
            peer,
            forwarded,
            &state.config.trusted_proxies,
        )))
    }
}

/// A token bucket per client address.
pub struct RateLimiter {
    per_second: f64,
    burst: f64,
    buckets: Mutex<HashMap<IpAddr, (f64, Instant)>>,
}

/// Past this many tracked addresses, idle ones are forgotten.
const MAX_TRACKED: usize = 50_000;

impl RateLimiter {
    /// `per_minute` of zero turns limiting off.
    pub fn new(per_minute: u32, burst: u32) -> Self {
        Self {
            per_second: f64::from(per_minute) / 60.0,
            burst: f64::from(burst.max(1)),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow(&self, address: IpAddr) -> bool {
        self.allow_at(address, Instant::now())
    }

    fn allow_at(&self, address: IpAddr, now: Instant) -> bool {
        if self.per_second <= 0.0 {
            return true;
        }
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if buckets.len() >= MAX_TRACKED {
            // A bucket that has refilled says nothing a new one would not.
            let (rate, burst) = (self.per_second, self.burst);
            buckets.retain(|_, (tokens, seen)| {
                *tokens + now.duration_since(*seen).as_secs_f64() * rate < burst
            });
        }
        let (tokens, seen) = buckets.entry(address).or_insert((self.burst, now));
        *tokens =
            (*tokens + now.duration_since(*seen).as_secs_f64() * self.per_second).min(self.burst);
        *seen = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Add to a handler to subject it to the limit on credential guessing.
pub struct AuthAttempt;

impl FromRequestParts<AppState> for AuthAttempt {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let ClientAddress(address) = ClientAddress::from_request_parts(parts, state).await?;
        if state.auth_limiter.allow(address) {
            Ok(Self)
        } else {
            Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "throttled",
                "Too many sign-in attempts. Wait a minute and try again.",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn nets(list: &[&str]) -> Vec<IpNet> {
        list.iter().map(|net| net.parse().unwrap()).collect()
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn untrusted_peer_cannot_name_its_own_address() {
        let trusted = nets(&["10.0.0.0/8"]);
        assert_eq!(
            client_address(ip("203.0.113.9"), Some("198.51.100.1"), &trusted),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn client_is_the_first_hop_no_trusted_proxy_vouches_for() {
        let trusted = nets(&["10.0.0.0/8", "127.0.0.0/8"]);
        // client -> edge proxy (10.0.0.2) -> local proxy (10.0.0.3) -> us
        assert_eq!(
            client_address(ip("10.0.0.3"), Some("203.0.113.9, 10.0.0.2"), &trusted),
            ip("203.0.113.9")
        );
        // The client put a forged entry in front; it is left of the real
        // one and never reached.
        assert_eq!(
            client_address(
                ip("10.0.0.3"),
                Some("198.51.100.1, 203.0.113.9, 10.0.0.2"),
                &trusted
            ),
            ip("203.0.113.9")
        );
        // No header at all: the proxy itself is the best answer there is.
        assert_eq!(
            client_address(ip("10.0.0.3"), None, &trusted),
            ip("10.0.0.3")
        );
        // Garbage ends the walk where it stands.
        assert_eq!(
            client_address(ip("10.0.0.3"), Some("nonsense, 10.0.0.2"), &trusted),
            ip("10.0.0.2")
        );
    }

    #[test]
    fn bucket_allows_a_burst_then_refills_at_the_rate() {
        let limiter = RateLimiter::new(60, 3);
        let start = Instant::now();
        let caller = ip("203.0.113.9");
        assert!(limiter.allow_at(caller, start));
        assert!(limiter.allow_at(caller, start));
        assert!(limiter.allow_at(caller, start));
        assert!(!limiter.allow_at(caller, start));
        // Another address has its own bucket.
        assert!(limiter.allow_at(ip("203.0.113.10"), start));
        // One token a second at 60 a minute.
        assert!(!limiter.allow_at(caller, start + Duration::from_millis(500)));
        assert!(limiter.allow_at(caller, start + Duration::from_millis(1100)));
        assert!(!limiter.allow_at(caller, start + Duration::from_millis(1200)));
    }

    #[test]
    fn zero_rate_means_no_limit() {
        let limiter = RateLimiter::new(0, 1);
        let caller = ip("203.0.113.9");
        assert!((0..1000).all(|_| limiter.allow(caller)));
    }
}
