pub mod packet;
pub mod auth;

use axum::{extract::State, response::IntoResponse, routing::{get, post}, Json, Router};
use serde::Serialize;

use crate::{core, db, storage};

pub fn router() -> Router<core::AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/status.bin", get(status_binary))
        .route("/auth/login", post(auth::login))
        .route("/auth/login.bin", post(auth::login_binary))
        .route("/packet", post(packet::packet))
        .route("/packet/batch", post(packet::packet_batch))
        .route("/debug/bus", get(packet::debug_bus))
        .route("/debug/schema", get(debug_schema))
        .route("/debug/entities", get(debug_entities))
}

async fn status(State(state): State<core::AppState>) -> Json<core::StatusResponse> {
    Json(core::StatusResponse {
        ok: true,
        service: "lmi-r-api",
        version: env!("CARGO_PKG_VERSION"),
        api_prefix: "/api-r",
        database: state.database_path,
        started_at: state.started_at,
        now: core::unix_ms(),
    })
}

async fn status_binary(State(state): State<core::AppState>) -> Result<impl IntoResponse, ApiError> {
    let status = core::StatusResponse {
        ok: true,
        service: "lmi-r-api",
        version: env!("CARGO_PKG_VERSION"),
        api_prefix: "/api-r",
        database: state.database_path,
        started_at: state.started_at,
        now: core::unix_ms(),
    };
    Ok(packet::binary_response(rmp_serde::to_vec_named(&status).map_err(anyhow::Error::new)?))
}

async fn debug_schema(State(state): State<core::AppState>) -> Result<Json<db::SchemaDebug>, ApiError> {
    Ok(Json(db::schema_debug(&state.db).await?))
}

async fn debug_entities(
    State(state): State<core::AppState>,
) -> Result<Json<storage::EntityListDebug>, ApiError> {
    Ok(Json(storage::list_entities_debug(&state.db).await?))
}

#[derive(Debug)]
pub struct ApiError(anyhow::Error);

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        #[derive(Serialize)]
        struct ErrorBody {
            ok: bool,
            error: String,
        }

        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                ok: false,
                error: self.0.to_string(),
            }),
        )
            .into_response()
    }
}
