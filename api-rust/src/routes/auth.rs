use axum::{body::Bytes, extract::State, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Row, SqlitePool};
use std::str::FromStr;

use crate::{core, routes::{packet::binary_response, ApiError}};

const ENTITY_KIND_USER_AUTH: i64 = 20;
const SCHEMA_USER_AUTH_BINARY: i64 = 2;
const CODEC_MSGPACK: i64 = 2;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub ok: bool,
    pub user: LoginUser,
}

#[derive(Clone, Serialize)]
pub struct LoginUser {
    pub username: String,
    pub cid: String,
    pub display_name: String,
    pub is_admin: bool,
    pub home_path: String,
    pub shell: String,
}

#[derive(Clone)]
struct LegacyCredential {
    username: String,
    password_hash: String,
    cid: String,
    display_name: String,
    is_admin: bool,
}

pub async fn login(
    State(state): State<core::AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    Ok(Json(login_inner(&state, req).await?))
}

pub async fn login_binary(
    State(state): State<core::AppState>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let req: LoginRequest = rmp_serde::from_slice(&body).map_err(anyhow::Error::new)?;
    let response = login_inner(&state, req).await?;
    Ok(binary_response(rmp_serde::to_vec_named(&response).map_err(anyhow::Error::new)?))
}

async fn login_inner(state: &core::AppState, req: LoginRequest) -> anyhow::Result<LoginResponse> {
    let username = req.username.trim();
    let password = req.password.trim();
    if username.is_empty() {
        anyhow::bail!("username is required");
    }
    if password.is_empty() {
        anyhow::bail!("password is required");
    }

    let user = if let Some(user) = login_from_lmi_r(&state.db, username, password).await? {
        user
    } else {
        let legacy = find_legacy_credential(&state.legacy_database_path, username, password).await?;
        persist_credential(&state.db, &legacy).await?;
        login_user_from_legacy(&legacy)
    };

    Ok(LoginResponse { ok: true, user })
}

async fn login_from_lmi_r(pool: &SqlitePool, username: &str, password: &str) -> anyhow::Result<Option<LoginUser>> {
    let slug = auth_slug(username);
    let row = sqlx::query(
        "SELECT es.payload FROM entity e JOIN entity_state es ON es.entity_id = e.id WHERE e.slug = ?1",
    )
    .bind(&slug)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let bytes: Vec<u8> = row.get("payload");
    let payload: Value = match rmp_serde::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            // One-time compatibility bridge for early LMI-R JSON credential blobs.
            let value: Value = serde_json::from_slice(&bytes)?;
            let binary = rmp_serde::to_vec_named(&value)?;
            sqlx::query(
                "UPDATE entity_state SET schema_id = ?1, codec = ?2, payload = ?3 WHERE entity_id = (
                    SELECT id FROM entity WHERE slug = ?4
                )",
            )
            .bind(SCHEMA_USER_AUTH_BINARY)
            .bind(CODEC_MSGPACK)
            .bind(binary)
            .bind(&slug)
            .execute(pool)
            .await?;
            value
        }
    };
    let stored_hash = payload.get("password_hash").and_then(Value::as_str).unwrap_or("");
    if stored_hash != password {
        anyhow::bail!("Invalid LMI-R username or password.");
    }

    Ok(Some(LoginUser {
        username: payload.get("username").and_then(Value::as_str).unwrap_or(username).to_string(),
        cid: payload.get("cid").and_then(Value::as_str).unwrap_or("").to_string(),
        display_name: payload.get("display_name").and_then(Value::as_str).unwrap_or(username).to_string(),
        is_admin: payload.get("is_admin").and_then(Value::as_bool).unwrap_or(false),
        home_path: payload.get("home_path").and_then(Value::as_str).unwrap_or("").to_string(),
        shell: payload.get("shell").and_then(Value::as_str).unwrap_or("terminal").to_string(),
    }))
}

async fn find_legacy_credential(path: &str, username: &str, password: &str) -> anyhow::Result<LegacyCredential> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(false)
        .disable_statement_logging();
    let pool = SqlitePool::connect_with(options).await?;
    let row = sqlx::query("SELECT rows_json FROM sheets WHERE name = 'core'")
        .fetch_one(&pool)
        .await?;
    let rows_json: String = row.get("rows_json");
    let rows: Vec<Value> = serde_json::from_str(&rows_json)?;
    let username_lc = username.to_lowercase();

    for row in rows {
        let tag = row.get("tag").or_else(|| row.get("username")).and_then(Value::as_str).unwrap_or("").trim();
        let hash = row.get("hash").or_else(|| row.get("password")).and_then(Value::as_str).unwrap_or("").trim();
        if tag.to_lowercase() == username_lc && hash == password {
            let cid = row.get("cid").or_else(|| row.get("id")).and_then(Value::as_str).unwrap_or("").to_string();
            let display_name = row.get("cn").or_else(|| row.get("displayName")).or_else(|| row.get("name")).and_then(Value::as_str).unwrap_or(tag).to_string();
            let access = row.get("al").or_else(|| row.get("access")).or_else(|| row.get("role")).and_then(Value::as_str).unwrap_or("");
            return Ok(LegacyCredential {
                username: tag.to_string(),
                password_hash: hash.to_string(),
                cid,
                display_name,
                is_admin: access.trim().eq_ignore_ascii_case("admin"),
            });
        }
    }

    anyhow::bail!("Invalid legacy LMI username or password.")
}

async fn persist_credential(pool: &SqlitePool, legacy: &LegacyCredential) -> anyhow::Result<()> {
    let slug = auth_slug(&legacy.username);
    let now = core::unix_ms();
    let home_path = home_path(&legacy.username, legacy.is_admin);
    let payload = rmp_serde::to_vec_named(&json!({
        "username": legacy.username,
        "password_hash": legacy.password_hash,
        "cid": legacy.cid,
        "display_name": legacy.display_name,
        "is_admin": legacy.is_admin,
        "home_path": home_path,
        "shell": "terminal",
        "imported_from": "legacy-core",
        "imported_at": now
    }))?;

    let mut tx = pool.begin().await?;
    let entity_id = if let Some(row) = sqlx::query("SELECT id FROM entity WHERE slug = ?1")
        .bind(&slug)
        .fetch_optional(&mut *tx)
        .await?
    {
        let id: i64 = row.get("id");
        sqlx::query("UPDATE entity SET updated = ?1, rev = rev + 1 WHERE id = ?2")
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        id
    } else {
        sqlx::query("INSERT INTO entity(kind, owner_id, slug, created, updated, rev) VALUES(?1, NULL, ?2, ?3, ?3, 0)")
            .bind(ENTITY_KIND_USER_AUTH)
            .bind(&slug)
            .bind(now)
            .execute(&mut *tx)
            .await?
            .last_insert_rowid()
    };

    sqlx::query(
        "INSERT INTO entity_state(entity_id, schema_id, codec, payload) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(entity_id) DO UPDATE SET schema_id = excluded.schema_id, codec = excluded.codec, payload = excluded.payload",
    )
    .bind(entity_id)
    .bind(SCHEMA_USER_AUTH_BINARY)
    .bind(CODEC_MSGPACK)
    .bind(payload)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

fn login_user_from_legacy(legacy: &LegacyCredential) -> LoginUser {
    LoginUser {
        username: legacy.username.clone(),
        cid: legacy.cid.clone(),
        display_name: legacy.display_name.clone(),
        is_admin: legacy.is_admin,
        home_path: home_path(&legacy.username, legacy.is_admin),
        shell: "terminal".to_string(),
    }
}

fn auth_slug(username: &str) -> String {
    format!("auth:{}", username.trim().to_lowercase())
}

fn home_path(username: &str, is_admin: bool) -> String {
    if is_admin {
        "/lmi-r/os".to_string()
    } else {
        let clean = username
            .trim()
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect::<String>();
        format!("/lmi-r/os/users/{}", clean.trim_matches('-'))
    }
}
