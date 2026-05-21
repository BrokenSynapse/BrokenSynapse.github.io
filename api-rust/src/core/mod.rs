use serde::Serialize;
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub database_path: String,
    pub started_at: i64,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub service: &'static str,
    pub version: &'static str,
    pub api_prefix: &'static str,
    pub database: String,
    pub started_at: i64,
    pub now: i64,
}

pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
