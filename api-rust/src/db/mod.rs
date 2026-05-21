use anyhow::Context;
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Row, SqlitePool};
use std::{path::Path, str::FromStr};

pub async fn connect(database_path: &str) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = Path::new(database_path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{database_path}"))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .foreign_keys(true)
        .pragma("busy_timeout", "5000")
        .disable_statement_logging();

    SqlitePool::connect_with(options)
        .await
        .with_context(|| format!("failed to open SQLite database at {database_path}"))
}

pub async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

#[derive(Serialize)]
pub struct TableInfo {
    pub name: String,
    pub sql: String,
}

#[derive(Serialize)]
pub struct SchemaDebug {
    pub tables: Vec<TableInfo>,
}

pub async fn schema_debug(pool: &SqlitePool) -> anyhow::Result<SchemaDebug> {
    let rows = sqlx::query(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(pool)
    .await?;

    Ok(SchemaDebug {
        tables: rows
            .into_iter()
            .map(|row| TableInfo {
                name: row.get("name"),
                sql: row.get("sql"),
            })
            .collect(),
    })
}
