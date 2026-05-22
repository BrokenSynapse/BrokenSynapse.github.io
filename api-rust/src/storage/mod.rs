pub mod event_log;

use serde::Serialize;
use sqlx::{Row, SqlitePool};

#[derive(Serialize)]
pub struct EntityDebug {
    pub id: i64,
    pub kind: i64,
    pub owner_id: Option<i64>,
    pub slug: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub rev: i64,
}

#[derive(Serialize)]
pub struct EntityListDebug {
    pub ok: bool,
    pub entities: Vec<EntityDebug>,
}

pub async fn list_entities_debug(pool: &SqlitePool) -> anyhow::Result<EntityListDebug> {
    let rows = sqlx::query(
        "SELECT id, kind, owner_id, slug, created, updated, rev FROM entity ORDER BY updated DESC, id DESC LIMIT 50",
    )
    .fetch_all(pool)
    .await?;

    Ok(EntityListDebug {
        ok: true,
        entities: rows
            .into_iter()
            .map(|row| EntityDebug {
                id: row.get("id"),
                kind: row.get("kind"),
                owner_id: row.get("owner_id"),
                slug: row.get("slug"),
                created: row.get("created"),
                updated: row.get("updated"),
                rev: row.get("rev"),
            })
            .collect(),
    })
}

pub async fn migrate_legacy_json_blobs(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT entity_id, payload FROM entity_state WHERE codec = 1",
    )
    .fetch_all(pool)
    .await?;

    for (entity_id, payload) in rows {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&payload) else {
            continue;
        };
        let binary = rmp_serde::to_vec_named(&value)?;
        sqlx::query("UPDATE entity_state SET codec = 2, payload = ?1 WHERE entity_id = ?2")
            .bind(binary)
            .bind(entity_id)
            .execute(pool)
            .await?;
    }

    event_log::migrate_legacy_json_events(pool).await
}
