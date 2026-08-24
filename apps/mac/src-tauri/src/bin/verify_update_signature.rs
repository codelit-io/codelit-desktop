use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

fn verify(
    public_key_path: &Path,
    artifact_path: &Path,
    signature_path: &Path,
) -> Result<(), String> {
    let public_key_text = fs::read_to_string(public_key_path)
        .map_err(|error| format!("Could not read public key: {error}"))?;
    let public_key = PublicKey::decode(public_key_text.trim())
        .map_err(|error| format!("Public key is invalid: {error}"))?;

    let encoded_signature = fs::read_to_string(signature_path)
        .map_err(|error| format!("Could not read signature: {error}"))?;
    let signature_bytes = STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| format!("Signature is not updater-compatible base64: {error}"))?;
    let signature_text = String::from_utf8(signature_bytes)
        .map_err(|error| format!("Decoded signature is not UTF-8: {error}"))?;
    let signature = Signature::decode(signature_text.trim())
        .map_err(|error| format!("Decoded signature is invalid: {error}"))?;

    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|error| format!("Could not initialize signature verification: {error}"))?;
    let mut artifact =
        File::open(artifact_path).map_err(|error| format!("Could not open artifact: {error}"))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes_read = artifact
            .read(&mut buffer)
            .map_err(|error| format!("Could not read artifact: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }
    verifier
        .finalize()
        .map_err(|error| format!("Signature verification failed: {error}"))
}

fn main() {
    let mut arguments = env::args_os().skip(1);
    let public_key = arguments.next();
    let artifact = arguments.next();
    let signature = arguments.next();
    if public_key.is_none()
        || artifact.is_none()
        || signature.is_none()
        || arguments.next().is_some()
    {
        eprintln!("Usage: verify-update-signature <public-key> <artifact> <signature>");
        std::process::exit(2);
    }

    if let Err(error) = verify(
        Path::new(&public_key.expect("checked above")),
        Path::new(&artifact.expect("checked above")),
        Path::new(&signature.expect("checked above")),
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }

    println!("Updater signature verified.");
}

#[cfg(test)]
mod tests {
    use super::verify;
    use std::path::Path;

    #[test]
    fn missing_inputs_fail_closed() {
        let result = verify(
            Path::new("missing-public-key"),
            Path::new("missing-artifact"),
            Path::new("missing-signature"),
        );
        assert!(result.is_err());
    }
}
