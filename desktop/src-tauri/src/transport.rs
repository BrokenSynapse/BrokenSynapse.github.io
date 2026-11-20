use std::{io, net::TcpListener, path::PathBuf, sync::Arc, time::Duration};

use crate::media_cache::{self, MediaCache};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderValue, Method, Request, Response, StatusCode, header},
};
use reqwest::Client;
use uuid::Uuid;

#[cfg(windows)]
pub const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
pub const APP_ORIGIN: &str = "tauri://localhost";

const API: &str = "https://brokensynapse.us/horizon-chat/api/";

fn upstream_url() -> String {
    #[cfg(feature = "qa-fixture")]
    if let Some(port) = std::env::var("HORIZON_FIXTURE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
    {
        return format!("http://127.0.0.1:{port}/horizon-chat/api/");
    }
    API.to_owned()
}
const CACHE_HEADER: &str = "x-horizon-cache-tag";
const CACHE_MISS: &str = "miss";
const MAX_UPLOAD: usize = 12 * 1024 * 1024;
const REQUEST_HEADERS: &str = "content-type, range, last-event-id, x-horizon-chat, x-horizon-filename, x-horizon-message-bytes, x-horizon-thumbnail, x-horizon-device";
const CORS_HEADERS: &str = "content-type, range, last-event-id, x-horizon-chat, x-horizon-filename, x-horizon-message-bytes, x-horizon-thumbnail, x-horizon-cache-only, x-horizon-device";
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "x-document-size",
    "content-encoding",
];

#[derive(Clone)]
struct Bridge {
    client: Client,
    recovery_client: Client,
    prefix: String,
    host: HeaderValue,
    offline: bool,
    cache: Option<MediaCache>,
    upstream: String,
    config: PathBuf,
}

pub fn start(
    offline: bool,
    cache: Option<MediaCache>,
    config: PathBuf,
) -> Result<String, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let host = listener.local_addr()?;
    let prefix = format!("/{}/", Uuid::new_v4());
    let root = format!("http://{host}{prefix}");
    let cookies = Arc::new(reqwest::cookie::Jar::default());
    let client_builder = || {
        Client::builder()
            .cookie_provider(cookies.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
    };
    let client = client_builder()
        .read_timeout(Duration::from_secs(35))
        .build()?;
    let recovery_client = client_builder().timeout(Duration::from_secs(110)).build()?;
    let router = Router::new().fallback(relay).with_state(Bridge {
        client,
        recovery_client,
        prefix,
        host: HeaderValue::from_str(&host.to_string())?,
        offline,
        cache,
        upstream: upstream_url(),
        config,
    });
    tauri::async_runtime::spawn(async move {
        let result: io::Result<()> = async {
            let listener = tokio::net::TcpListener::from_std(listener)?;
            axum::serve(listener, router).await
        }
        .await;
        if let Err(err) = result {
            eprintln!("Horizon transport stopped: {err}");
        }
    });
    Ok(root)
}

fn valid_route(route: &str) -> bool {
    !route.is_empty()
        && route.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
}

fn cacheable_chunk(route: &str, query: Option<&str>) -> bool {
    let parts: Vec<_> = route.split('/').collect();
    matches!(parts.as_slice(), ["conversations", conversation, "messages", message, "document"]
        if [conversation, message].iter().all(|id| id.bytes().all(|b| b.is_ascii_digit())))
        && query
            .and_then(|q| q.strip_prefix("offset=")?.strip_suffix("&encoding=gzip"))
            .is_some_and(|offset| !offset.is_empty() && offset.bytes().all(|b| b.is_ascii_digit()))
}

fn response(status: StatusCode, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(APP_ORIGIN),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(
            "Content-Disposition, X-Document-Size, Content-Range, Accept-Ranges",
        ),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn relay(State(bridge): State<Bridge>, request: Request<Body>) -> Response<Body> {
    if request.headers().get(header::HOST) != Some(&bridge.host) {
        return response(StatusCode::FORBIDDEN, Body::empty());
    }
    let Some(route) = request
        .uri()
        .path()
        .strip_prefix(&bridge.prefix)
        .filter(|route| valid_route(route))
    else {
        return response(StatusCode::NOT_FOUND, Body::empty());
    };
    let origin = request.headers().get(header::ORIGIN);
    let trusted = origin.is_some_and(|value| value == APP_ORIGIN);
    if origin.is_some() && !trusted || request.method() == Method::POST && !trusted {
        return response(StatusCode::FORBIDDEN, Body::empty());
    }
    if request.method() == Method::OPTIONS && trusted {
        let mut reply = response(StatusCode::NO_CONTENT, Body::empty());
        reply.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST"),
        );
        reply.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(CORS_HEADERS),
        );
        return reply;
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD | Method::POST) {
        return response(StatusCode::METHOD_NOT_ALLOWED, Body::empty());
    }
    if request.method() == Method::POST
        && request
            .headers()
            .get("x-horizon-chat")
            .is_none_or(|value| value != "1")
    {
        return response(StatusCode::FORBIDDEN, Body::empty());
    }
    if bridge.offline {
        return response(StatusCode::SERVICE_UNAVAILABLE, Body::empty());
    }
    if route.starts_with("local-peer/") {
        let local_route = route.to_owned();
        return local_peer(bridge, &local_route, request).await;
    }
    let cache_only = request.headers().contains_key("x-horizon-cache-only");
    let request_method_allows_cache = request.method() == Method::GET
        && !request.headers().contains_key(header::RANGE)
        && cacheable_chunk(route, request.uri().query());
    let mut target = format!("{}{route}", bridge.upstream);
    if let Some(query) = request.uri().query() {
        target.push('?');
        target.push_str(query);
    }
    let recovery_commit = route.starts_with("recovery-archive/restore/")
        && route.ends_with("/commit")
        || route.starts_with("hosted-archives/") && route.ends_with("/finish");
    let client = if recovery_commit {
        &bridge.recovery_client
    } else {
        &bridge.client
    };
    let mut upstream = client.request(request.method().clone(), target.clone());
    for name in REQUEST_HEADERS.split(", ") {
        if let Some(value) = request.headers().get(name) {
            upstream = upstream.header(name, value);
        }
    }
    if request.method() == Method::POST {
        let Ok(bytes) = axum::body::to_bytes(request.into_body(), MAX_UPLOAD).await else {
            return response(StatusCode::PAYLOAD_TOO_LARGE, Body::empty());
        };
        upstream = upstream.body(bytes);
    }
    if request_method_allows_cache && let Some(cache) = bridge.cache {
        return relay_chunk(upstream, cache, target, cache_only).await;
    }
    if cache_only {
        return response(StatusCode::NOT_FOUND, Body::empty());
    }
    relay_response(
        tokio::time::timeout(
            Duration::from_secs(if recovery_commit { 110 } else { 30 }),
            upstream.send(),
        )
        .await
        .ok()
        .and_then(Result::ok),
    )
}

async fn relay_chunk(
    request: reqwest::RequestBuilder,
    cache: MediaCache,
    key: String,
    cache_only: bool,
) -> Response<Body> {
    if cache_only && cache.tag(&key).is_none() {
        return response(StatusCode::NOT_FOUND, Body::empty());
    }
    let tag = cache.tag(&key).unwrap_or_else(|| CACHE_MISS.into());
    let mut conditional = request
        .try_clone()
        .expect("cache requests have no body")
        .header(CACHE_HEADER, tag.clone());
    if cache_only {
        conditional = conditional.header("x-horizon-cache-only", "1");
    }
    let Ok(Ok(mut upstream)) =
        tokio::time::timeout(Duration::from_secs(8), conditional.send()).await
    else {
        return relay_response(None);
    };
    if upstream.status() == StatusCode::NOT_MODIFIED {
        let confirmed = upstream
            .headers()
            .get(header::ETAG)
            .and_then(|tag| tag.to_str().ok())
            == Some(tag.as_str());
        if confirmed && let Some(digest) = media_cache::tag_digest(&tag) {
            let (cache, key, digest) = (cache.clone(), key.clone(), digest.to_owned());
            let found = tokio::task::spawn_blocking(move || cache.read(&key, &digest))
                .await
                .ok()
                .flatten();
            if let Some(bytes) = found {
                return chunk_reply(upstream.headers(), Body::from(bytes));
            }
        }
        if cache_only {
            return response(StatusCode::NOT_FOUND, Body::empty());
        }
        let Ok(Ok(retry)) = tokio::time::timeout(
            Duration::from_secs(8),
            request.header(CACHE_HEADER, CACHE_MISS).send(),
        )
        .await
        else {
            return relay_response(None);
        };
        upstream = retry;
    }
    if cache_only {
        return response(StatusCode::NOT_FOUND, Body::empty());
    }
    let digest = upstream
        .headers()
        .get(header::ETAG)
        .and_then(|tag| tag.to_str().ok())
        .and_then(media_cache::tag_digest)
        .map(str::to_owned);
    if upstream.status() != StatusCode::OK || digest.is_none() {
        return relay_response(Some(upstream));
    }
    let digest = digest.unwrap();
    let headers = upstream.headers().clone();
    let mut bytes = Vec::new();
    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 320 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return response(StatusCode::BAD_GATEWAY, Body::empty()),
        }
    }
    if media_cache::hex_digest(&bytes) != digest {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    }
    let stored = bytes.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(error) = cache.put(&key, &digest, &stored) {
            eprintln!("Could not store a media chunk: {error}");
        }
    });
    chunk_reply(&headers, Body::from(bytes))
}

async fn local_peer(bridge: Bridge, route: &str, request: Request<Body>) -> Response<Body> {
    if request.method() != Method::POST {
        return response(StatusCode::METHOD_NOT_ALLOWED, Body::empty());
    }
    if route == "local-peer/metered" {
        let value = tokio::task::spawn_blocking(network_metered)
            .await
            .ok()
            .flatten();
        let mut reply = response(
            StatusCode::OK,
            Body::from(serde_json::json!({ "metered": value }).to_string()),
        );
        reply.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        return reply;
    }
    let Some(cache) = bridge.cache else {
        return response(StatusCode::NOT_FOUND, Body::empty());
    };
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), 320 * 1024).await else {
        return response(StatusCode::PAYLOAD_TOO_LARGE, Body::empty());
    };
    if route == "local-peer/cache-limit" {
        let limit = serde_json::from_slice::<u64>(&bytes)
            .ok()
            .filter(|value| *value <= 8192);
        let Some(limit) = limit else {
            return response(StatusCode::BAD_REQUEST, Body::empty());
        };
        let updated = tokio::task::spawn_blocking(move || {
            cache.set_limit(limit * 1024 * 1024)?;
            std::fs::write(bridge.config.join("cache-limit-mib"), limit.to_string())
        })
        .await;
        return response(
            if matches!(updated, Ok(Ok(()))) {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            Body::empty(),
        );
    }
    let parts: Vec<_> = route.split('/').collect();
    let ["local-peer", ticket, peer, operation @ ("seed" | "store")] = parts.as_slice() else {
        return response(StatusCode::NOT_FOUND, Body::empty());
    };
    if Uuid::parse_str(ticket).is_err() || Uuid::parse_str(peer).is_err() {
        return response(StatusCode::BAD_REQUEST, Body::empty());
    }
    let grant = bridge
        .client
        .post(format!("{}peers/{ticket}/{operation}", bridge.upstream))
        .header("x-horizon-chat", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "peer": peer }).to_string())
        .timeout(Duration::from_secs(4))
        .send()
        .await;
    let Ok(grant) = grant else {
        return response(StatusCode::SERVICE_UNAVAILABLE, Body::empty());
    };
    if !grant.status().is_success() {
        return response(StatusCode::FORBIDDEN, Body::empty());
    }
    #[derive(serde::Deserialize)]
    struct Grant {
        route: String,
        hash: String,
        size: usize,
    }
    let Ok(grant) = grant.bytes().await else {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    };
    let Ok(grant) = serde_json::from_slice::<Grant>(&grant) else {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    };
    let Some((path, query)) = grant.route.split_once('?') else {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    };
    if !valid_route(path)
        || !cacheable_chunk(path, Some(query))
        || grant.size > 320 * 1024
        || media_cache::tag_digest(&format!("\"hc-{}\"", grant.hash)).is_none()
    {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    }
    let key = format!("{}{}", bridge.upstream, grant.route);
    if *operation == "seed" {
        let found = tokio::task::spawn_blocking(move || {
            cache
                .read(&key, &grant.hash)
                .filter(|bytes| bytes.len() == grant.size)
        })
        .await
        .ok()
        .flatten();
        return match found {
            Some(bytes) => chunk_reply(&Default::default(), Body::from(bytes)),
            None => response(StatusCode::NOT_FOUND, Body::empty()),
        };
    }
    let good = bytes.len() == grant.size
        && matches!(
            tokio::task::spawn_blocking(move || cache.put(&key, &grant.hash, &bytes)).await,
            Ok(Ok(()))
        );
    response(
        if good {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::BAD_REQUEST
        },
        Body::empty(),
    )
}

fn network_metered() -> Option<bool> {
    #[cfg(windows)]
    {
        use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
        let value = NetworkInformation::GetInternetConnectionProfile()
            .ok()?
            .GetConnectionCost()
            .ok()?
            .NetworkCostType()
            .ok()?;
        if value == NetworkCostType::Unrestricted {
            return Some(false);
        }
        if value == NetworkCostType::Fixed || value == NetworkCostType::Variable {
            return Some(true);
        }
    }
    None
}

fn chunk_reply(headers: &axum::http::HeaderMap, body: Body) -> Response<Body> {
    let mut reply = response(StatusCode::OK, body);
    reply.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Some(size) = headers.get("x-document-size") {
        reply.headers_mut().insert("x-document-size", size.clone());
    }
    reply
}

fn relay_response(upstream: Option<reqwest::Response>) -> Response<Body> {
    let Some(upstream) = upstream else {
        return response(
            StatusCode::SERVICE_UNAVAILABLE,
            Body::from("Horizon server is unavailable."),
        );
    };
    if upstream.status().is_redirection() {
        return response(StatusCode::BAD_GATEWAY, Body::empty());
    }
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut reply = response(status, Body::from_stream(upstream.bytes_stream()));
    for &name in RESPONSE_HEADERS {
        if let Some(value) = headers.get(name) {
            reply.headers_mut().insert(name, value.clone());
        }
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn accepts_api_routes_without_allowing_url_or_path_escape() {
        assert!(valid_route("conversations/12/messages/4/document"));
        assert!(valid_route("emoji-art/1.2"));
        for invalid in [
            "",
            "/session",
            "../session",
            "x/%2e%2e/y",
            "//elsewhere",
            "a\\b",
        ] {
            assert!(!valid_route(invalid), "{invalid}");
        }
    }

    #[tokio::test]
    async fn protects_writes_and_retains_upstream_cookies_for_events() {
        let server = Router::new()
            .route(
                "/login",
                axum::routing::post(|| async {
                    (
                        [(
                            header::SET_COOKIE,
                            "horizon_session=fixture; HttpOnly; SameSite=Strict; Path=/",
                        )],
                        "{}",
                    )
                }),
            )
            .route(
                "/events",
                axum::routing::get(|headers: HeaderMap| async move {
                    if headers
                        .get(header::COOKIE)
                        .is_some_and(|value| value == "horizon_session=fixture")
                    {
                        (
                            StatusCode::OK,
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            "event: ready\ndata: 1\n\n",
                        )
                    } else {
                        (
                            StatusCode::UNAUTHORIZED,
                            [(header::CONTENT_TYPE, "text/plain")],
                            "",
                        )
                    }
                }),
            );
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let process = tokio::spawn(async move { axum::serve(upstream, server).await.unwrap() });
        let bridge = Bridge {
            client: Client::builder().cookie_store(true).build().unwrap(),
            recovery_client: Client::new(),
            prefix: "/token/".into(),
            host: HeaderValue::from_static("127.0.0.1:1234"),
            offline: false,
            cache: None,
            upstream: format!("http://{address}/"),
            config: std::env::temp_dir(),
        };
        let send = |method, path, origin| {
            relay(
                State(bridge.clone()),
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::HOST, "127.0.0.1:1234")
                    .header(header::ORIGIN, origin)
                    .header("x-horizon-chat", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
        };
        assert_eq!(
            send(Method::POST, "/token/login", "https://untrusted.example")
                .await
                .status(),
            403
        );
        assert_eq!(
            send(Method::GET, "/wrong/events", APP_ORIGIN)
                .await
                .status(),
            404
        );
        assert_eq!(
            send(Method::GET, "/token/events", APP_ORIGIN)
                .await
                .status(),
            401
        );
        let login = send(Method::POST, "/token/login", APP_ORIGIN).await;
        assert_eq!(login.status(), 200);
        assert!(!login.headers().contains_key(header::SET_COOKIE));
        for _ in 0..2 {
            let events = send(Method::GET, "/token/events", APP_ORIGIN).await;
            assert_eq!(events.status(), 200);
            assert_eq!(events.headers()[header::CONTENT_TYPE], "text/event-stream");
            assert_eq!(
                axum::body::to_bytes(events.into_body(), 1024)
                    .await
                    .unwrap(),
                "event: ready\ndata: 1\n\n"
            );
        }
        process.abort();
    }
}
