use serde_json::json;
use sqlx::SqlitePool;

use crate::core::{self, packet::LmiPacket};

pub async fn append_packet(pool: &SqlitePool, packet: &LmiPacket) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(packet)?;
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

    let packets = rows
        .into_iter()
        .map(|(id, op, payload)| {
            let packet = serde_json::from_slice::<serde_json::Value>(&payload).unwrap_or_else(|_| json!({}));
            json!({ "id": id, "op": op, "packet": packet })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "ok": true,
        "recentPackets": packets,
        "capabilities": crate::core::capabilities::known()
    }))
}
