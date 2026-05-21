mod codec;
mod core;
mod db;
mod routes;
mod storage;

use anyhow::Context;
use axum::Router;
use std::{env, net::SocketAddr};
use tokio::net::TcpListener;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let bind = env::var("LMI_R_BIND").unwrap_or_else(|_| "0.0.0.0:3100".to_string());
    let database_path = env::var("LMI_R_DB").unwrap_or_else(|_| "../data/lmi-r.sqlite".to_string());
    let db = db::connect(&database_path).await?;
    db::migrate(&db).await?;

    let state = core::AppState {
        db,
        database_path,
        started_at: core::unix_ms(),
    };

    let app = Router::new()
        .nest("/api-r", routes::router())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = bind.parse().context("invalid LMI_R_BIND")?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(%addr, "LMI-R Rust API listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
