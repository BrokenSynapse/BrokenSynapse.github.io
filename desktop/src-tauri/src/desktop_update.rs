use crate::update_handoff::{HANDOFF, decode_hash, encode_hash, installation_dir};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Manager, WebviewWindow};
use tokio::io::AsyncWriteExt;

const REPO: &str = "BrokenSynapse/BrokenSynapse.github.io";
const METADATA_LIMIT: usize = 2 * 1024 * 1024;
const INSTALLER_LIMIT: u64 = 1024 * 1024 * 1024;
static UPDATING: AtomicBool = AtomicBool::new(false);

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
    size: u64,
    digest: Option<String>,
}

#[derive(Debug)]
struct Update {
    version: String,
    size: u64,
    sha256: [u8; 32],
}

impl Update {
    fn url(&self) -> String {
        let version = &self.version;
        format!(
            "https://github.com/{REPO}/releases/download/horizon-v{version}/Horizon-Chat-{version}-Windows-x64-Update.exe.gz"
        )
    }
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

fn available_update(releases: Vec<Release>, installed: [u32; 3]) -> Option<Update> {
    releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let text = release.tag_name.strip_prefix("horizon-v")?;
            let candidate = version(text)?;
            if candidate <= installed {
                return None;
            }
            let name = format!("Horizon-Chat-{text}-Windows-x64-Update.exe.gz");
            let asset = release
                .assets
                .iter()
                .find(|asset| asset.name == name && asset.state == "uploaded")?;
            let hash = decode_hash(asset.digest.as_deref()?.strip_prefix("sha256:")?)?;
            if asset.size == 0 || asset.size > INSTALLER_LIMIT {
                return None;
            }
            Some((
                candidate,
                Update {
                    version: text.to_owned(),
                    size: asset.size,
                    sha256: hash,
                },
            ))
        })
        .max_by_key(|entry| entry.0)
        .map(|entry| entry.1)
}

fn trusted(window: &WebviewWindow) -> bool {
    window.label() == "horizon" && window.url().is_ok_and(|url| super::is_horizon(&url))
}

fn network_client(download: bool) -> Result<reqwest::Client, String> {
    let redirects = if download {
        reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() < 4
                && url.scheme() == "https"
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(
                    url.host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("Unexpected update download redirect")
            }
        })
    } else {
        reqwest::redirect::Policy::none()
    };
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(if download { 45 } else { 8 }))
        .timeout(Duration::from_secs(if download { 3600 } else { 12 }))
        .redirect(redirects)
        .user_agent(concat!("HorizonDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not start the update connection.".into())
}

async fn latest() -> Result<Option<Update>, String> {
    let installed = version(env!("CARGO_PKG_VERSION")).expect("valid desktop version");
    #[cfg(feature = "qa-fixture")]
    if let Ok(text) = std::env::var("HORIZON_FIXTURE_RELEASES") {
        return serde_json::from_str(&text)
            .map(|releases| available_update(releases, installed))
            .map_err(|_| "Invalid fixture release metadata.".into());
    }

    let unavailable = "Could not check for an update. Try again later.";
    let mut response = network_client(false)?
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases?per_page=20"
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| unavailable)?
        .error_for_status()
        .map_err(|_| unavailable)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable)? {
        if bytes.len() + chunk.len() > METADATA_LIMIT {
            return Err(unavailable.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(|releases| available_update(releases, installed))
        .map_err(|_| unavailable.into())
}

struct DownloadFile {
    path: PathBuf,
    launched: bool,
}

impl Drop for DownloadFile {
    fn drop(&mut self) {
        if !self.launched {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct UpdateLock;

impl Drop for UpdateLock {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::Release);
    }
}

fn update_folder(window: &WebviewWindow) -> Result<PathBuf, String> {
    #[cfg(feature = "qa-fixture")]
    if let Some(path) = std::env::var_os("HORIZON_FIXTURE_UPDATE_FOLDER") {
        return Ok(PathBuf::from(path));
    }
    window
        .app_handle()
        .path()
        .app_local_data_dir()
        .map(|path| path.join("desktop-updates"))
        .map_err(|_| "Could not find a folder for the update.".into())
}

fn cleanup_update_helpers(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .and_then(|name| uuid::Uuid::parse_str(name).ok())
            .is_none()
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            || !entry
                .metadata()
                .and_then(|value| value.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age >= Duration::from_secs(7200))
        {
            continue;
        }
        let path = entry.path();
        let _ = std::fs::remove_file(path.join("horizon-update-helper.exe"));
        let _ = std::fs::remove_file(path.join("update.exe.gz"));
        let _ = std::fs::remove_dir(path);
    }
}

fn report(window: &WebviewWindow, phase: &'static str, percent: u64) {
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('horizon-update-progress',{{detail:{{phase:'{phase}',percent:{percent}}}}}))"
    ));
}

fn unpack(
    archive: &Path,
    candidate: &Path,
    compressed_size: u64,
    progress: impl Fn(u64),
) -> std::io::Result<[u8; 32]> {
    use std::{
        fs::{File, OpenOptions},
        io::{BufRead, BufReader, BufWriter, Read, Seek, Write},
    };
    let source = BufReader::new(File::open(archive)?);
    let mut decoder = flate2::bufread::GzDecoder::new(source);
    let mut output = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(candidate)?,
    );
    let mut bytes = [0_u8; 64 * 1024];
    let mut size = 0;
    let mut percent = 0;
    let mut digest = Sha256::new();
    loop {
        let count = decoder.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > INSTALLER_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Update expands beyond size limit",
            ));
        }
        output.write_all(&bytes[..count])?;
        digest.update(&bytes[..count]);
        let next = (decoder.get_mut().stream_position()? * 100 / compressed_size).min(99);
        if next > percent {
            percent = next;
            progress(next);
        }
    }
    if !decoder.into_inner().fill_buf()?.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Unexpected trailing update data",
        ));
    }
    output.flush()?;
    output.get_ref().sync_all()?;
    let mut mz = [0; 2];
    File::open(candidate)?.read_exact(&mut mz)?;
    if mz != *b"MZ" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Update is not a Windows executable",
        ));
    }
    progress(100);
    Ok(digest.finalize().into())
}

async fn download_archive(
    update: &Update,
    output: &Path,
    progress: impl Fn(u64),
) -> Result<(), String> {
    let error = "The update download failed. Try again.";
    let url = update.url();
    #[cfg(feature = "qa-fixture")]
    let url = std::env::var("HORIZON_FIXTURE_UPDATE_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .map_or(url, |port| format!("http://127.0.0.1:{port}/update.exe.gz"));
    let mut response = network_client(true)?
        .get(url)
        .send()
        .await
        .map_err(|_| error)?
        .error_for_status()
        .map_err(|_| error)?;
    if response
        .content_length()
        .is_some_and(|length| length != update.size)
    {
        return Err("The downloaded update has the wrong size.".into());
    }
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .await
        .map_err(|_| "Could not save the update. Check your available disk space.")?;
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut percent = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| error)? {
        size += chunk.len() as u64;
        if size > update.size {
            return Err("The downloaded update has the wrong size.".into());
        }
        digest.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|_| "Could not save the update. Check your available disk space.")?;
        let next = size * 100 / update.size;
        if next > percent {
            percent = next;
            progress(percent);
        }
    }
    if size != update.size || <[u8; 32]>::from(digest.finalize()) != update.sha256 {
        return Err("The download failed verification. Horizon has not been updated.".into());
    }
    output.flush().await.map_err(|_| error)?;
    output.sync_all().await.map_err(|_| error)?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_update_version(window: WebviewWindow) -> Option<String> {
    if !trusted(&window) || std::env::args().any(|arg| arg == "--offline") {
        return None;
    }
    if let Ok(folder) = update_folder(&window) {
        if !UPDATING.load(Ordering::Acquire) {
            cleanup_update_helpers(&folder);
        }
    }
    latest().await.ok().flatten().map(|update| update.version)
}

#[tauri::command]
pub async fn desktop_install_update(
    window: WebviewWindow,
    available: String,
) -> Result<(), String> {
    if !trusted(&window) || std::env::args().any(|arg| arg == "--offline") {
        return Err("This update is unavailable.".into());
    }
    if UPDATING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("An update is already running.".into());
    }
    let _lock = UpdateLock;
    let update = latest()
        .await?
        .filter(|update| update.version == available)
        .ok_or("This update has changed. Check again for the latest version.")?;

    let running =
        std::env::current_exe().map_err(|_| "Could not find the current installation.")?;
    let install_dir = installation_dir(&running)
        .ok_or("Install Horizon with Windows Setup before using in-app updates.")?;
    let folder = update_folder(&window)?;
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|_| "Could not create the update folder.")?;
    let id = uuid::Uuid::new_v4();
    let scratch = folder.join(id.to_string());
    tokio::fs::create_dir(&scratch)
        .await
        .map_err(|_| "Could not create the update folder.")?;
    let archive = DownloadFile {
        path: scratch.join("update.exe.gz"),
        launched: false,
    };
    download_archive(&update, &archive.path, |percent| {
        report(&window, "download", percent)
    })
    .await?;
    report(&window, "unpack", 0);
    let mut candidate = DownloadFile {
        path: install_dir.join(format!("horizon-update-{id}.pending")),
        launched: false,
    };
    let archive_path = archive.path.clone();
    let candidate_path = candidate.path.clone();
    let progress_window = window.clone();
    let size = update.size;
    let digest = tauri::async_runtime::spawn_blocking(move || {
        unpack(&archive_path, &candidate_path, size, |percent| {
            report(&progress_window, "unpack", percent)
        })
    })
    .await
    .map_err(|_| "Could not unpack the update.")?
    .map_err(|_| "Could not unpack the update. Check disk space and installation permissions.")?;
    drop(archive);
    let mut helper = DownloadFile {
        path: scratch.join("horizon-update-helper.exe"),
        launched: false,
    };
    tokio::fs::copy(&running, &helper.path)
        .await
        .map_err(|_| "Could not prepare the restart.")?;
    report(&window, "restart", 100);
    tokio::time::sleep(Duration::from_millis(180)).await;
    Command::new(&helper.path)
        .arg(HANDOFF)
        .arg(&running)
        .arg(id.to_string())
        .arg(std::process::id().to_string())
        .arg(encode_hash(&digest))
        .spawn()
        .map_err(|_| "Windows could not start the update handoff.")?;
    candidate.launched = true;
    helper.launched = true;
    window.app_handle().exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, asset: &str, hash: Option<&str>, prerelease: bool) -> Release {
        Release {
            tag_name: tag.into(),
            draft: false,
            prerelease,
            assets: vec![Asset {
                name: asset.into(),
                state: "uploaded".into(),
                size: 1024,
                digest: hash.map(|hash| format!("sha256:{hash}")),
            }],
        }
    }

    #[test]
    fn accepts_only_verified_newer_stable_windows_assets() {
        let digest = "a".repeat(64);
        let releases = vec![
            release(
                "horizon-v0.6.1",
                "Horizon-Chat-0.6.1-Windows-x64-Update.exe.gz",
                Some(&digest),
                false,
            ),
            release(
                "horizon-v0.10.0",
                "Horizon-Chat-0.10.0-Windows-x64-Update.exe.gz",
                Some(&digest),
                false,
            ),
            release(
                "horizon-v0.11.0",
                "Horizon-Chat-0.11.0-Windows-x64-Update.exe.gz",
                None,
                false,
            ),
            release(
                "horizon-v1.0.0",
                "Horizon-Chat-1.0.0-Windows-x64-Update.exe.gz",
                Some(&digest),
                true,
            ),
            release("horizon-v2.0.0", "other.exe", Some(&digest), false),
        ];
        let selected = available_update(releases, [0, 6, 1]).unwrap();
        assert_eq!(selected.version, "0.10.0");
        assert_eq!(selected.sha256, [0xaa; 32]);
        assert!(
            selected
                .url()
                .starts_with("https://github.com/BrokenSynapse/")
        );
        assert!(version("0.6.2/../").is_none());
        assert!(version("0.06.1").is_none());
    }
}
