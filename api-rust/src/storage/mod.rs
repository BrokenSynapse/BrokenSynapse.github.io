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
