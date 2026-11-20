use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString, c_void},
    fs::{self, File},
    io::{self, Read},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::Command,
};

pub const APP_BINARY: &str = "horizon-chat-desktop.exe";
pub const HANDOFF: &str = "--horizon-apply-update";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn ReplaceFileW(
        replaced: *const u16,
        replacement: *const u16,
        backup: *const u16,
        flags: u32,
        exclude: *mut c_void,
        reserved: *mut c_void,
    ) -> i32;
}

fn wait_for_exit(pid: u32) -> io::Result<()> {
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        // ERROR_INVALID_PARAMETER indicates that the process has already exited.
        return if error.raw_os_error() == Some(87) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let result = unsafe { WaitForSingleObject(handle, 20_000) };
    let error = io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    match result {
        0 => Ok(()),
        258 => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Horizon is still running",
        )),
        _ => Err(error),
    }
}

fn path_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

fn replace(target: &Path, candidate: &Path, backup: &Path) -> io::Result<()> {
    let target = path_wide(target);
    let candidate = path_wide(candidate);
    let backup = path_wide(backup);
    let status = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            candidate.as_ptr(),
            backup.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if status == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn installation_dir(executable: &Path) -> Option<&Path> {
    #[cfg(feature = "qa-fixture")]
    if let Some(dir) = executable
        .parent()
        .filter(|dir| dir.join("update-qa.marker").is_file())
    {
        return Some(dir);
    }
    let name = executable.file_name()?.to_str()?;
    executable
        .parent()
        .filter(|dir| name.eq_ignore_ascii_case(APP_BINARY) && dir.join("uninstall.exe").is_file())
}

fn hash(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(digest.finalize().into());
        }
        digest.update(&buffer[..count]);
    }
}

pub fn decode_hash(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

pub fn encode_hash(hash: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut value = String::with_capacity(64);
    for byte in hash {
        write!(value, "{byte:02x}").expect("writing to a string");
    }
    value
}

pub fn run_if_requested() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(HANDOFF)) {
        return false;
    }
    let values: Vec<OsString> = args.collect();
    if let [target, id, pid, digest] = values.as_slice() {
        let target = PathBuf::from(target);
        let id = id.to_str().and_then(|id| uuid::Uuid::parse_str(id).ok());
        let pid = pid
            .to_str()
            .and_then(|pid| pid.parse::<u32>().ok())
            .filter(|pid| *pid != 0);
        let digest = digest.to_str().and_then(decode_hash);
        let helper = std::env::current_exe().ok();
        if let (Some(dir), Some(id), Some(pid), Some(digest), Some(helper)) =
            (installation_dir(&target), id, pid, digest, helper)
        {
            if helper.file_name().and_then(OsStr::to_str) == Some("horizon-update-helper.exe") {
                apply(&target, dir, id, pid, digest);
            }
        }
    }
    true
}

fn apply(target: &Path, dir: &Path, id: uuid::Uuid, pid: u32, expected: [u8; 32]) {
    let next = dir.join(format!("horizon-update-{id}.pending"));
    let backup = dir.join(format!("horizon-update-{id}.previous"));
    let result = (|| {
        wait_for_exit(pid)?;
        if hash(&next)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Update changed after verification",
            ));
        }
        replace(target, &next, &backup)?;
        if let Err(error) = Command::new(target).spawn() {
            if backup.is_file() {
                let rejected = dir.join(format!("horizon-update-{id}.rejected"));
                if replace(target, &backup, &rejected).is_ok() {
                    let _ = fs::remove_file(rejected);
                }
            }
            return Err(error);
        }
        let _ = fs::remove_file(&backup);
        Ok(())
    })();
    if result.is_err() {
        // ReplaceFileW can report failure after moving the old file to the backup.
        if !target.exists() && backup.is_file() {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(&next);
        if target.is_file() && wait_for_exit(pid).is_ok() {
            let _ = Command::new(target).arg("--horizon-update-failed").spawn();
        }
    }
}
