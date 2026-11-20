use tauri::WebviewWindow;

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
