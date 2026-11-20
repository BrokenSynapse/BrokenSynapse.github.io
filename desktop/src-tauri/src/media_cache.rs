use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_ENTRIES: usize = 16_384;
const MAX_CHUNK: u64 = 320 * 1024;

#[derive(Clone)]
pub struct MediaCache(Arc<Mutex<DiskCache>>);

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    digest: String,
    size: u64,
    touched: u64,
}

struct DiskCache {
    root: PathBuf,
    limit: u64,
    entries: HashMap<String, Entry>,
    _lock: File,
}

pub fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn tag_digest(tag: &str) -> Option<&str> {
    tag.strip_prefix("\"hc-")?
        .strip_suffix('"')
        .filter(|value| is_digest(value))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = fs::write(&temp, bytes).and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

impl MediaCache {
    pub fn open(root: PathBuf, limit: u64) -> io::Result<Self> {
        fs::create_dir_all(root.join("objects"))?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("lock"))?;
        lock.try_lock().map_err(io::Error::other)?;
        let mut entries: HashMap<String, Entry> = fs::read(root.join("index.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        entries.retain(|key, entry| {
            is_digest(key) && is_digest(&entry.digest) && entry.size <= MAX_CHUNK
        });
        let mut cache = DiskCache {
            root,
            limit,
            entries,
            _lock: lock,
        };
        cache.prune()?;
        Ok(Self(Arc::new(Mutex::new(cache))))
    }

    fn disk(&self) -> MutexGuard<'_, DiskCache> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn tag(&self, key: &str) -> Option<String> {
        let digest = self
            .disk()
            .entries
            .get(&hex_digest(key.as_bytes()))?
            .digest
            .clone();
        Some(format!("\"hc-{digest}\""))
    }

    pub fn read(&self, key: &str, digest: &str) -> Option<Vec<u8>> {
        let key = hex_digest(key.as_bytes());
        let mut cache = self.disk();
        let entry = cache.entries.get(&key)?.clone();
        if entry.digest != digest {
            return None;
        }
        let path = cache.root.join("objects").join(digest);
        let bytes = fs::metadata(&path)
            .ok()
            .filter(|meta| meta.len() == entry.size)
            .and_then(|_| fs::read(&path).ok())
            .filter(|bytes| hex_digest(bytes) == digest);
        if bytes.is_some() {
            cache.entries.get_mut(&key)?.touched = now();
            let _ = cache.save_index();
        } else {
            cache.entries.retain(|_, item| item.digest != digest);
            let _ = fs::remove_file(path);
            let _ = cache.save_index();
        }
        bytes
    }

    pub fn put(&self, key: &str, digest: &str, bytes: &[u8]) -> io::Result<()> {
        let size = bytes.len() as u64;
        if size == 0 || size > MAX_CHUNK || hex_digest(bytes) != digest {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid attachment checksum or size",
            ));
        }
        let mut cache = self.disk();
        if size > cache.limit {
            return Ok(());
        }
        let entry = Entry {
            digest: digest.to_owned(),
            size,
            touched: now(),
        };
        let object = cache.root.join("objects").join(digest);
        if !fs::metadata(&object).is_ok_and(|meta| meta.len() == size) {
            atomic_write(&object, bytes)?;
        }
        cache.entries.insert(hex_digest(key.as_bytes()), entry);
        cache.prune()
    }

    pub fn clear(&self) -> io::Result<()> {
        let mut cache = self.disk();
        cache.entries.clear();
        cache.prune()
    }

    pub fn set_limit(&self, bytes: u64) -> io::Result<()> {
        let mut cache = self.disk();
        cache.limit = bytes;
        cache.prune()
    }
}

impl DiskCache {
    fn save_index(&self) -> io::Result<()> {
        atomic_write(
            &self.root.join("index.json"),
            &serde_json::to_vec(&self.entries)?,
        )
    }

    fn prune(&mut self) -> io::Result<()> {
        let mut groups = HashMap::<String, (u64, u64)>::new();
        for entry in self.entries.values() {
            let group = groups
                .entry(entry.digest.clone())
                .or_insert((entry.size, entry.touched));
            group.1 = group.1.max(entry.touched);
        }
        let mut ordered: Vec<_> = groups.into_iter().collect();
        ordered.sort_unstable_by_key(|(_, (_, touched))| std::cmp::Reverse(*touched));
        let mut retained = HashSet::new();
        let mut remaining = self.limit;
        for (digest, (size, _)) in ordered {
            if size <= remaining {
                remaining -= size;
                retained.insert(digest);
            }
        }
        self.entries
            .retain(|_, entry| retained.contains(&entry.digest));
        if self.entries.len() > MAX_ENTRIES {
            let mut by_age: Vec<_> = self
                .entries
                .iter()
                .map(|(key, entry)| (entry.touched, key.clone()))
                .collect();
            by_age.sort_unstable();
            for (_, key) in by_age.into_iter().take(self.entries.len() - MAX_ENTRIES) {
                self.entries.remove(&key);
            }
            retained = self
                .entries
                .values()
                .map(|entry| entry.digest.clone())
                .collect();
        }
        for file in fs::read_dir(self.root.join("objects"))? {
            let file = file?;
            if !retained.contains(file.file_name().to_string_lossy().as_ref())
                && file.file_type()?.is_file()
            {
                fs::remove_file(file.path())?;
            }
        }
        self.save_index()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_deduplicates_evicts_and_detects_corruption() {
        let root = std::env::temp_dir().join(format!("horizon-test-{}", Uuid::new_v4()));
        let first = hex_digest(b"first");
        let second = hex_digest(b"second");
        let cache = MediaCache::open(root.clone(), 11).unwrap();
        cache.put("a", &first, b"first").unwrap();
        cache.put("b", &first, b"first").unwrap();
        cache.put("c", &second, b"second").unwrap();
        assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 2);
        drop(cache);
        let cache = MediaCache::open(root.clone(), 11).unwrap();
        assert_eq!(cache.read("b", &first), Some(b"first".to_vec()));
        fs::write(root.join("objects").join(&first), b"wrong").unwrap();
        assert!(cache.read("a", &first).is_none());
        assert!(cache.tag("b").is_none());
        drop(cache);
        let cache = MediaCache::open(root.clone(), 5).unwrap();
        assert!(cache.tag("c").is_none());
        cache.clear().unwrap();
        drop(cache);
        fs::remove_dir(root.join("objects")).unwrap();
        fs::remove_file(root.join("index.json")).unwrap();
        fs::remove_file(root.join("lock")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
