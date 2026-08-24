use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_ARTIFACT_FILE_BYTES: usize = 32 * 1024 * 1024;

pub struct StoredArtifactFile {
    pub hash: String,
    pub relative_path: String,
    pub size: u64,
}

pub fn store(root: &Path, bytes: &[u8]) -> Result<StoredArtifactFile, String> {
    if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_FILE_BYTES {
        return Err("Artifact files must contain between 1 byte and 32 MB.".into());
    }
    let hash = sha256_hex(bytes);
    let relative_path = format!("sha256/{}/{}", &hash[..2], hash);
    let path = root.join(&relative_path);
    if path.exists() {
        let existing = fs::read(&path)
            .map_err(|error| format!("Could not verify the existing artifact file: {error}"))?;
        if sha256_hex(&existing) != hash {
            return Err("An existing artifact file failed its content hash check.".into());
        }
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| "Artifact file path is invalid.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the artifact file directory: {error}"))?;
        write_atomic(&path, bytes)?;
    }
    Ok(StoredArtifactFile {
        hash,
        relative_path,
        size: bytes.len() as u64,
    })
}

pub fn read(root: &Path, hash: &str) -> Result<Vec<u8>, String> {
    validate_hash(hash)?;
    let path = root.join(format!("sha256/{}/{}", &hash[..2], hash));
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect the artifact file: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_FILE_BYTES as u64 {
        return Err("The artifact file is empty or larger than 32 MB.".into());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read the artifact file: {error}"))?;
    if sha256_hex(&bytes) != hash {
        return Err("The artifact file failed its content hash check.".into());
    }
    Ok(bytes)
}

pub fn prune_except(root: &Path, retained_hashes: &HashSet<String>) -> Result<(), String> {
    let sha_root = root.join("sha256");
    if !sha_root.exists() {
        return Ok(());
    }
    for prefix_entry in fs::read_dir(&sha_root)
        .map_err(|error| format!("Could not inspect the artifact file directory: {error}"))?
    {
        let prefix_entry = prefix_entry
            .map_err(|error| format!("Could not inspect an artifact file directory: {error}"))?;
        let prefix_path = prefix_entry.path();
        if !prefix_entry
            .file_type()
            .map_err(|error| format!("Could not inspect an artifact file directory: {error}"))?
            .is_dir()
        {
            return Err("The artifact store contains an unexpected entry.".into());
        }
        for file_entry in fs::read_dir(&prefix_path)
            .map_err(|error| format!("Could not inspect artifact files: {error}"))?
        {
            let file_entry = file_entry
                .map_err(|error| format!("Could not inspect an artifact file: {error}"))?;
            let hash = file_entry
                .file_name()
                .into_string()
                .map_err(|_| "An artifact file has an invalid name.".to_string())?;
            validate_hash(&hash)?;
            if !file_entry
                .file_type()
                .map_err(|error| format!("Could not inspect an artifact file: {error}"))?
                .is_file()
            {
                return Err("The artifact store contains an unexpected entry.".into());
            }
            if !retained_hashes.contains(&hash) {
                fs::remove_file(file_entry.path())
                    .map_err(|error| format!("Could not remove an old artifact file: {error}"))?;
            }
        }
        if fs::read_dir(&prefix_path)
            .map_err(|error| format!("Could not inspect an artifact file directory: {error}"))?
            .next()
            .is_none()
        {
            fs::remove_dir(&prefix_path).map_err(|error| {
                format!("Could not remove an empty artifact directory: {error}")
            })?;
        }
    }
    Ok(())
}

pub fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Artifact file hash is invalid.".into());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Could not create the artifact file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Could not write the artifact file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not finish the artifact file: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not store the artifact file: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Artifact file name is invalid.".to_string())?;
    Ok(path.with_file_name(format!(".{name}.{}.tmp", std::process::id())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn content_addressed_file_round_trips_and_deduplicates() {
        let directory = tempdir().expect("directory");
        let first = store(directory.path(), b"local artifact").expect("first store");
        let second = store(directory.path(), b"local artifact").expect("second store");
        assert_eq!(first.hash, second.hash);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(
            read(directory.path(), &first.hash).expect("read"),
            b"local artifact"
        );
    }

    #[test]
    fn invalid_hash_and_tampered_file_are_rejected() {
        let directory = tempdir().expect("directory");
        assert!(read(directory.path(), "../escape").is_err());
        let stored = store(directory.path(), b"original").expect("store");
        fs::write(directory.path().join(&stored.relative_path), b"changed").expect("tamper");
        assert!(read(directory.path(), &stored.hash).is_err());
    }

    #[test]
    fn pruning_removes_only_unreferenced_content() {
        let directory = tempdir().expect("directory");
        let retained = store(directory.path(), b"retained").expect("retained");
        let removed = store(directory.path(), b"removed").expect("removed");
        prune_except(directory.path(), &HashSet::from([retained.hash.clone()])).expect("prune");
        assert_eq!(
            read(directory.path(), &retained.hash).expect("read"),
            b"retained"
        );
        assert!(read(directory.path(), &removed.hash).is_err());
    }
}
