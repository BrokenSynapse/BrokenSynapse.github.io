#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, io, path::Path};
use tauri::{
    Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    menu::{CheckMenuItem, MenuBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

mod media_cache;
mod transport;
#[cfg(windows)]
mod windows_chrome;

const BROKEN_SYNAPSE: &str = "https://brokensynapse.us/";

fn is_horizon(url: &Url) -> bool {
    url.scheme() == if cfg!(windows) { "http" } else { "tauri" }
        && url.host_str()
            == Some(if cfg!(windows) {
                "tauri.localhost"
            } else {
                "localhost"
            })
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

fn save_tray_preference(path: &Path, enabled: bool) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, if enabled { "enabled" } else { "disabled" })?;
    fs::rename(temporary, path)
}

fn open_in_browser(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("Could not open link in the default browser: {error}");
    }
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        windows_chrome::desktop_window_action,
        windows_chrome::desktop_update_version,
        windows_chrome::desktop_open_update,
    ]);
    builder
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            #[cfg(feature = "qa-fixture")]
            let directory = std::env::var_os("HORIZON_FIXTURE_CONFIG")
                .map(std::path::PathBuf::from)
                .unwrap_or(directory);
            fs::create_dir_all(&directory)?;
            let preference = directory.join("close-to-tray");
            let cache_limit = fs::read_to_string(directory.join("cache-limit-mib"))
                .ok()
                .and_then(|text| text.trim().parse::<u64>().ok())
                .unwrap_or(2048)
                .min(8192)
                * 1024
                * 1024;
            let cache_path = app.path().app_cache_dir()?.join("chat-media-v1");
            #[cfg(feature = "qa-fixture")]
            let cache_path = std::env::var_os("HORIZON_FIXTURE_CACHE")
                .map(std::path::PathBuf::from)
                .unwrap_or(cache_path);
            let cache = media_cache::MediaCache::open(cache_path, cache_limit)
                .map_err(|error| eprintln!("Media cache unavailable: {error}"))
                .ok();
            let endpoint = transport::start(
                std::env::args().any(|arg| arg == "--offline"),
                cache.clone(),
                directory.clone(),
            )?;
            let platform_script = format!(
                "Object.defineProperty(window, '__HORIZON_DESKTOP_API__', {{value: {}}});",
                serde_json::to_string(&endpoint)?
            );

            let title = if cfg!(feature = "qa-fixture")
                && std::env::var_os("HORIZON_FIXTURE_PORT").is_some()
            {
                "Horizon Chat · Local Recovery Sandbox"
            } else {
                "Horizon Chat"
            };
            let window =
                WebviewWindowBuilder::new(app, "horizon", WebviewUrl::App("index.html".into()));
            #[cfg(windows)]
            let window = window
                .decorations(false)
                .initialization_script(concat!(
                    "Object.defineProperty(window,'__HORIZON_TITLEBAR_ICON__',{value:'data:image/png;base64,",
                    include_str!("../icons/titlebar.png.b64"),
                    "'});",
                    include_str!("windows-chrome.js"),
                ));
            let window = window
                .initialization_script(platform_script)
                .title(title)
                .inner_size(1280.0, 800.0)
                .on_navigation(|url| {
                    if url.as_str() == BROKEN_SYNAPSE {
                        open_in_browser(url);
                    }
                    is_horizon(url)
                })
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "https" | "http") {
                        open_in_browser(&url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;

            let close_to_tray = CheckMenuItem::with_id(
                app,
                "close-to-tray",
                "Keep running in tray when closed",
                true,
                fs::read_to_string(&preference).as_deref().ok() == Some("enabled"),
                None::<&str>,
            )?;
            let launch_at_startup = CheckMenuItem::with_id(
                app,
                "launch-at-startup",
                "Launch at startup",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let menu = MenuBuilder::new(app)
                .text("show", "Show Horizon Chat")
                .separator()
                .item(&close_to_tray)
                .item(&launch_at_startup)
                .text("clear-media-cache", "Clear chat media cache")
                .separator()
                .text("quit", "Quit Horizon Chat")
                .build()?;

            let event_window = window.clone();
            let close_item = close_to_tray.clone();
            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("Horizon Chat")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        let _ = event_window.show();
                        let _ = event_window
                            .eval("window.dispatchEvent(new Event('horizon-tray-shown'))");
                        let _ = event_window.unminimize();
                        let _ = event_window.set_focus();
                    }
                    "close-to-tray" => update_tray_preference(&preference, &close_item),
                    "launch-at-startup" => {
                        let manager = app.autolaunch();
                        let enabled = launch_at_startup.is_checked().unwrap_or(false);
                        let result = if enabled {
                            manager.enable()
                        } else {
                            manager.disable()
                        };
                        if let Err(error) = result {
                            let _ = launch_at_startup
                                .set_checked(manager.is_enabled().unwrap_or(false));
                            eprintln!("Could not update startup preference: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    "clear-media-cache" => {
                        if let Some(cache) = cache.clone() {
                            tauri::async_runtime::spawn_blocking(move || {
                                if let Err(error) = cache.clear() {
                                    eprintln!("Could not clear the chat media cache: {error}");
                                }
                            });
                        }
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            match tray_builder.build(app) {
                Ok(tray) => {
                    app.manage(tray);
                    let main_window = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            if close_to_tray.is_checked().unwrap_or(false)
                                && main_window.hide().is_ok()
                            {
                                let _ = main_window
                                    .eval("window.dispatchEvent(new Event('horizon-tray-hidden'))");
                                api.prevent_close();
                            }
                        }
                    });
                }
                Err(error) => eprintln!("System tray unavailable: {error}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not launch Horizon Chat");
}

fn update_tray_preference(path: &Path, item: &CheckMenuItem<tauri::Wry>) {
    if let Ok(enabled) = item.is_checked() {
        if let Err(error) = save_tray_preference(path, enabled) {
            let _ = item.set_checked(!enabled);
            eprintln!("Could not save tray preference: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_the_packaged_horizon_page() {
        for path in ["/", "/index.html?invite=abc"] {
            assert!(is_horizon(
                &format!("{}{path}", transport::APP_ORIGIN).parse().unwrap()
            ));
        }
        for rejected in [
            "https://brokensynapse.us/horizon-chat/",
            "http://tauri.localhost:8443/index.html",
            "http://tauri.localhost.example.org/index.html",
            "http://tauri.localhost/elsewhere.html",
            "http://alice@tauri.localhost/index.html",
        ] {
            assert!(!is_horizon(&rejected.parse().unwrap()), "{rejected}");
        }
    }
}
