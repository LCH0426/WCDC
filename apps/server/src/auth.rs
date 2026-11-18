use std::collections::HashMap;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::{header, HeaderMap};
use tokio::sync::{Mutex, MutexGuard, RwLock};
use tracing::{info, warn};

pub const AUTH_SETTING_KEY: &str = "web_password_hash";
pub const SESSION_COOKIE: &str = "wcdc_session";
pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const MAX_FAILURES: u32 = 5;
const LOCK_MS: i64 = 60_000;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("尚未设置访问密码")]
    NotRegistered,
    #[error("已经注册过访问密码")]
    AlreadyRegistered,
    #[error("访问密码不正确")]
    InvalidPassword,
    #[error("访问密码长度需为 8-128 位")]
    InvalidPasswordLength,
    #[error("尝试次数过多，请 {0} 秒后再试")]
    Locked(u64),
    #[error("认证服务内部错误")]
    Internal,
}

struct AuthInner {
    password_hash: Option<String>,
    sessions: HashMap<String, i64>,
    failures: u32,
    locked_until_ms: i64,
}

/// Single site password, password-only account. Sessions are in memory and
/// use an HttpOnly cookie; restarting the server requires signing in again.
pub struct AuthService {
    inner: RwLock<AuthInner>,
    register_lock: Mutex<()>,
}

impl AuthService {
    pub fn new(password_hash: Option<String>) -> Self {
        Self {
            inner: RwLock::new(AuthInner {
                password_hash,
                sessions: HashMap::new(),
                failures: 0,
                locked_until_ms: 0,
            }),
            register_lock: Mutex::new(()),
        }
    }

    pub async fn registration_lock(&self) -> MutexGuard<'_, ()> {
        self.register_lock.lock().await
    }

    pub async fn has_password(&self) -> bool {
        self.inner
            .read()
            .await
            .password_hash
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    }

    pub async fn install_password_hash(&self, hash: String) {
        let mut inner = self.inner.write().await;
        inner.password_hash = Some(hash);
        inner.failures = 0;
        inner.locked_until_ms = 0;
    }

    pub async fn login(&self, password: &str) -> Result<String, AuthError> {
        let now = now_ms();
        let (hash, locked_until) = {
            let inner = self.inner.read().await;
            (inner.password_hash.clone(), inner.locked_until_ms)
        };
        if now < locked_until {
            return Err(AuthError::Locked(
                (((locked_until - now) / 1000) + 1) as u64,
            ));
        }
        let Some(hash) = hash else {
            return Err(AuthError::NotRegistered);
        };
        if !verify_password(&hash, password).await {
            let mut inner = self.inner.write().await;
            inner.failures = inner.failures.saturating_add(1);
            if inner.failures >= MAX_FAILURES {
                inner.failures = 0;
                inner.locked_until_ms = now + LOCK_MS;
                warn!("site login locked after too many failed attempts");
                return Err(AuthError::Locked((LOCK_MS / 1000) as u64));
            }
            warn!(
                attempts = inner.failures,
                "site login failed: invalid password"
            );
            return Err(AuthError::InvalidPassword);
        }
        let token = new_token();
        let mut inner = self.inner.write().await;
        inner.failures = 0;
        inner.locked_until_ms = 0;
        prune_sessions(&mut inner.sessions, now);
        inner.sessions.insert(token.clone(), now + SESSION_TTL_MS);
        info!("site login succeeded");
        Ok(token)
    }

    pub async fn create_session(&self) -> String {
        let token = new_token();
        let now = now_ms();
        let mut inner = self.inner.write().await;
        prune_sessions(&mut inner.sessions, now);
        inner.sessions.insert(token.clone(), now + SESSION_TTL_MS);
        token
    }

    pub async fn is_authenticated(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        let now = now_ms();
        let mut inner = self.inner.write().await;
        let valid = inner
            .sessions
            .get(token)
            .copied()
            .is_some_and(|expires_at| expires_at > now);
        if valid {
            inner
                .sessions
                .insert(token.to_string(), now + SESSION_TTL_MS);
        } else {
            inner.sessions.remove(token);
        }
        valid
    }

    pub async fn logout(&self, token: &str) {
        if token.is_empty() {
            return;
        }
        self.inner.write().await.sessions.remove(token);
        info!("site logout");
    }

    pub async fn hash_password(password: &str) -> Result<String, AuthError> {
        let password = password.to_string();
        tokio::task::spawn_blocking(move || {
            let salt_bytes = uuid::Uuid::new_v4().into_bytes();
            let salt = SaltString::encode_b64(&salt_bytes).map_err(|_| AuthError::Internal)?;
            Argon2::default()
                .hash_password(password.as_bytes(), &salt)
                .map(|hash| hash.to_string())
                .map_err(|_| AuthError::Internal)
        })
        .await
        .map_err(|_| AuthError::Internal)?
    }
}

pub async fn verify_password(hash: &str, password: &str) -> bool {
    let hash = hash.to_string();
    let password = password.to_string();
    tokio::task::spawn_blocking(move || {
        let Ok(parsed) = PasswordHash::new(&hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
    .await
    .unwrap_or(false)
}

pub fn validate_password(password: &str) -> Result<(), AuthError> {
    let length = password.len();
    if !(8..=128).contains(&length) {
        return Err(AuthError::InvalidPasswordLength);
    }
    if password.trim().is_empty() {
        return Err(AuthError::InvalidPasswordLength);
    }
    Ok(())
}

pub fn session_from_headers(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, SESSION_COOKIE)
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        let (key, value) = part.split_once('=')?;
        if key.trim() == name {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn cookie_path() -> String {
    std::env::var("WCDC_COOKIE_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with('/'))
        .unwrap_or_else(|| "/".to_string())
}

pub fn session_cookie(token: &str, secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path={}; HttpOnly; SameSite=Strict; Max-Age={}{}",
        cookie_path(),
        SESSION_TTL_MS / 1000,
        if secure { "; Secure" } else { "" }
    )
}

pub fn clear_session_cookie(secure: bool) -> String {
    format!(
        "{SESSION_COOKIE}=; Path={}; HttpOnly; SameSite=Strict; Max-Age=0{}",
        cookie_path(),
        if secure { "; Secure" } else { "" }
    )
}

pub fn request_is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn prune_sessions(sessions: &mut HashMap<String, i64>, now: i64) {
    sessions.retain(|_, expires_at| *expires_at > now);
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
