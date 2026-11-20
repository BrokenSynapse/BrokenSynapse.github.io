use serde::Deserialize;
use std::time::Duration;
use tauri::WebviewWindow;

const REPO: &str = "https://github.com/BrokenSynapse/BrokenSynapse.github.io";
const RELEASES_API: &str =
    "https://api.github.com/repos/BrokenSynapse/BrokenSynapse.github.io/releases?per_page=20";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
}

fn version(text: &str) -> Option<[u32; 3]> {
    let mut parts = text.split('.');
    let mut result = [0; 3];
    for part in &mut result {
        let value = parts.next()?;
        if value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return None;
        }
        *part = value.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

fn available_releases(releases: Vec<Release>) -> Option<String> {
    let installed = version(env!("CARGO_PKG_VERSION"))?;
    releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let text = release.tag_name.strip_prefix("horizon-v")?;
            let candidate = version(text)?;
            let asset = format!("Horizon-Chat-{text}-Windows-x64-Setup.exe");
            (candidate > installed
                && release
                    .assets
                    .iter()
                    .any(|entry| entry.name == asset && entry.state == "uploaded"))
            .then(|| (candidate, text.to_owned()))
        })
        .max_by_key(|entry| entry.0)
        .map(|entry| entry.1)
}

fn trusted(window: &WebviewWindow) -> bool {
    window.label() == "horizon" && window.url().is_ok_and(|url| super::is_horizon(&url))
}

#[tauri::command]
pub fn desktop_window_action(window: WebviewWindow, action: &str) -> Result<bool, String> {
    if !trusted(&window) {
        return Err("This action requires the Horizon desktop window.".to_owned());
    }
    let operation = match action {
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        "maximize" => window.maximize(),
        "close" => window.close(),
        "state" => Ok(()),
        _ => return Err("Unknown window action.".to_owned()),
    };
    operation
        .and_then(|_| window.is_maximized())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_update_version(window: WebviewWindow) -> Option<String> {
    if !trusted(&window) || std::env::args().any(|arg| arg == "--offline") {
        return None;
    }
    #[cfg(feature = "qa-fixture")]
    if let Ok(text) = std::env::var("HORIZON_FIXTURE_RELEASES") {
        return available_releases(serde_json::from_str(&text).ok()?);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("HorizonDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let mut response = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    available_releases(serde_json::from_slice(&bytes).ok()?)
}

#[tauri::command]
pub fn desktop_open_update(window: WebviewWindow, available: &str) -> Result<(), String> {
    if !trusted(&window)
        || !version(available)
            .zip(version(env!("CARGO_PKG_VERSION")))
            .is_some_and(|(offered, installed)| offered > installed)
    {
        return Err("This update is unavailable.".to_owned());
    }
    open::that_detached(format!("{REPO}/releases/tag/horizon-v{available}"))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_only_newer_public_horizon_windows_releases() {
        let releases = serde_json::from_str(r#"[
          {"tag_name":"horizon-v0.6.0","draft":false,"prerelease":false,"assets":[{"name":"Horizon-Chat-0.6.0-Windows-x64-Setup.exe","state":"uploaded"}]},
          {"tag_name":"horizon-v0.10.0","draft":false,"prerelease":false,"assets":[{"name":"Horizon-Chat-0.10.0-Windows-x64-Setup.exe","state":"uploaded"}]},
          {"tag_name":"horizon-v0.11.0","draft":false,"prerelease":false,"assets":[]},
          {"tag_name":"horizon-v1.0.0","draft":false,"prerelease":true,"assets":[{"name":"Horizon-Chat-1.0.0-Windows-x64-Setup.exe","state":"uploaded"}]},
          {"tag_name":"horizon-v2.0.0","draft":true,"prerelease":false,"assets":[{"name":"Horizon-Chat-2.0.0-Windows-x64-Setup.exe","state":"uploaded"}]}
        ]"#).unwrap();
        assert_eq!(available_releases(releases).as_deref(), Some("0.10.0"));
        assert!(version("0.6.1/../").is_none());
        assert!(version("0.06.1").is_none());
    }
}
