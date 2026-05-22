use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderValue},
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

use crate::{
    core::{self, opcodes, packet::LmiPacket},
    routes::ApiError,
    storage::event_log,
};

const ENTITY_KIND_STATE: i64 = 30;
const STATE_SCHEMA_BINARY: i64 = 1;
const CODEC_MSGPACK: i64 = 2;

pub async fn packet(
    State(state): State<core::AppState>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let packet = decode_packet(&body)?;
    let response = handle_packet(&state.db, packet).await?;
    Ok(binary_response(encode_packet(&response)?))
}

pub async fn packet_batch(
    State(state): State<core::AppState>,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let packets: Vec<LmiPacket> = rmp_serde::from_slice(&body).map_err(anyhow::Error::new)?;
    let mut responses = Vec::with_capacity(packets.len());
    for packet in packets {
        responses.push(handle_packet(&state.db, packet).await?);
    }
    Ok(binary_response(rmp_serde::to_vec_named(&responses).map_err(anyhow::Error::new)?))
}

pub async fn debug_bus(State(state): State<core::AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(event_log::debug_recent(&state.db).await?))
}

async fn handle_packet(pool: &SqlitePool, packet: LmiPacket) -> anyhow::Result<LmiPacket> {
    event_log::append_packet(pool, &packet).await?;
    let payload = match packet.op {
        opcodes::STATE_SET => set_state(pool, &packet).await?,
        opcodes::STATE_GET => get_state(pool, &packet).await?,
        opcodes::DEBUG_DUMP_BUS => event_log::debug_recent(pool).await?,
        _ => json!({ "ok": true, "stored": true, "op": packet.op }),
    };
    let response = LmiPacket::response_to(&packet, payload);
    event_log::append_packet(pool, &response).await?;
    Ok(response)
}

async fn set_state(pool: &SqlitePool, packet: &LmiPacket) -> anyhow::Result<Value> {
    let payload = packet.payload.as_ref().unwrap_or(&Value::Null);
    let key = payload.get("key").and_then(Value::as_str).unwrap_or("").trim();
    let scope = payload.get("scope").and_then(Value::as_str).unwrap_or("user").trim();
    let value = payload.get("value").cloned().unwrap_or(Value::Null);
    anyhow::ensure!(!key.is_empty(), "state key is required");

    let slug = format!("state:{scope}:{key}");
    let now = core::unix_ms();
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
        let result = sqlx::query("INSERT INTO entity(kind, owner_id, slug, created, updated, rev) VALUES(?1, NULL, ?2, ?3, ?3, 0)")
            .bind(ENTITY_KIND_STATE)
            .bind(&slug)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        result.last_insert_rowid()
    };

    let state_payload = rmp_serde::to_vec_named(&json!({ "key": key, "scope": scope, "value": value }))?;
    sqlx::query(
        "INSERT INTO entity_state(entity_id, schema_id, codec, payload) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(entity_id) DO UPDATE SET schema_id = excluded.schema_id, codec = excluded.codec, payload = excluded.payload",
    )
    .bind(entity_id)
    .bind(STATE_SCHEMA_BINARY)
    .bind(CODEC_MSGPACK)
    .bind(state_payload)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(json!({ "ok": true, "key": key, "scope": scope, "entityId": entity_id }))
}

async fn get_state(pool: &SqlitePool, packet: &LmiPacket) -> anyhow::Result<Value> {
    let payload = packet.payload.as_ref().unwrap_or(&Value::Null);
    let key = payload.get("key").and_then(Value::as_str).unwrap_or("").trim();
    let scope = payload.get("scope").and_then(Value::as_str).unwrap_or("user").trim();
    anyhow::ensure!(!key.is_empty(), "state key is required");
    let slug = format!("state:{scope}:{key}");

    let row = sqlx::query(
        "SELECT es.payload FROM entity e JOIN entity_state es ON es.entity_id = e.id WHERE e.slug = ?1",
    )
    .bind(&slug)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        let bytes: Vec<u8> = row.get("payload");
        let stored: Value = match rmp_serde::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                // One-time compatibility bridge for early LMI-R JSON state blobs.
                let migrated: Value = serde_json::from_slice(&bytes)?;
                let binary = rmp_serde::to_vec_named(&migrated)?;
                sqlx::query(
                    "UPDATE entity_state SET schema_id = ?1, codec = ?2, payload = ?3 WHERE entity_id = (
                        SELECT id FROM entity WHERE slug = ?4
                    )",
                )
                .bind(STATE_SCHEMA_BINARY)
                .bind(CODEC_MSGPACK)
                .bind(binary)
                .bind(&slug)
                .execute(pool)
                .await?;
                migrated
            }
        };
        Ok(json!({ "ok": true, "key": key, "scope": scope, "value": stored.get("value").cloned().unwrap_or(Value::Null) }))
    } else {
        Ok(json!({ "ok": true, "key": key, "scope": scope, "value": null }))
    }
}

fn decode_packet(body: &[u8]) -> anyhow::Result<LmiPacket> {
    rmp_serde::from_slice(body).map_err(Into::into)
}

fn encode_packet(packet: &LmiPacket) -> anyhow::Result<Vec<u8>> {
    rmp_serde::to_vec_named(packet).map_err(Into::into)
}

fn binary_response(body: Vec<u8>) -> (HeaderMap, Vec<u8>) {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-msgpack"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, body)
}
