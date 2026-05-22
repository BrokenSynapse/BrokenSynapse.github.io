use serde_json::json;
use sqlx::SqlitePool;

use crate::core::{self, packet::LmiPacket};

pub async fn append_packet(pool: &SqlitePool, packet: &LmiPacket) -> anyhow::Result<()> {
    let payload = rmp_serde::to_vec_named(packet)?;
    sqlx::query("INSERT INTO event_log(ts, actor_id, op, entity_id, payload) VALUES(?1, NULL, ?2, NULL, ?3)")
        .bind(core::unix_ms())
        .bind(packet.op)
        .bind(payload)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn debug_recent(pool: &SqlitePool) -> anyhow::Result<serde_json::Value> {
    let rows: Vec<(i64, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT id, op, payload FROM event_log ORDER BY id DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;

    let mut packets = Vec::with_capacity(rows.len());
    for (id, op, payload) in rows {
        let packet = match rmp_serde::from_slice::<serde_json::Value>(&payload) {
            Ok(value) => value,
            Err(_) => {
                // One-time compatibility bridge for early LMI-R JSON event rows.
                let value = serde_json::from_slice::<serde_json::Value>(&payload).unwrap_or_else(|_| json!({}));
                if let Ok(binary) = rmp_serde::to_vec_named(&value) {
                    sqlx::query("UPDATE event_log SET payload = ?1 WHERE id = ?2")
                        .bind(binary)
                        .bind(id)
                        .execute(pool)
                        .await?;
                }
                value
            }
        };
        packets.push(json!({ "id": id, "op": op, "packet": packet }));
    }

    Ok(json!({
        "ok": true,
        "recentPackets": packets,
        "capabilities": crate::core::capabilities::known()
    }))
}

pub async fn migrate_legacy_json_events(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as("SELECT id, payload FROM event_log")
        .fetch_all(pool)
        .await?;

    for (id, payload) in rows {
        if rmp_serde::from_slice::<serde_json::Value>(&payload).is_ok() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&payload) else {
            continue;
        };
        let binary = rmp_serde::to_vec_named(&value)?;
        sqlx::query("UPDATE event_log SET payload = ?1 WHERE id = ?2")
            .bind(binary)
            .bind(id)
            .execute(pool)
            .await?;
    }

    Ok(())
}
