use std::path::Path;
use std::process::Command;

fn git_output(arguments: &[&str]) -> String {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .output()
        .unwrap_or_else(|error| panic!("Could not inspect release source: {error}"));
    if !output.status.success() {
        panic!(
            "git {} failed while building release identity",
            arguments.join(" ")
        );
    }
    String::from_utf8(output.stdout)
        .expect("git output must be UTF-8")
        .trim()
        .to_string()
}

fn main() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let head_path = repository.join(".git/HEAD");
    println!("cargo:rerun-if-changed={}", head_path.display());
    if let Ok(head) = std::fs::read_to_string(&head_path)
        && let Some(reference) = head.trim().strip_prefix("ref: ")
    {
        println!(
            "cargo:rerun-if-changed={}",
            repository.join(".git").join(reference).display()
        );
    }
    println!("cargo:rerun-if-env-changed=CODELIT_BUILD_SOURCE_COMMIT");
    println!("cargo:rerun-if-env-changed=CODELIT_BUILD_SOURCE_DIRTY");
    let commit = std::env::var("CODELIT_BUILD_SOURCE_COMMIT")
        .unwrap_or_else(|_| git_output(&["rev-parse", "HEAD"]));
    let dirty = std::env::var("CODELIT_BUILD_SOURCE_DIRTY")
        .map(|value| value == "true")
        .unwrap_or_else(|_| {
            !git_output(&["status", "--porcelain", "--untracked-files=normal"]).is_empty()
        });
    assert!(
        commit.len() == 40
            && commit
                .chars()
                .all(|character| character.is_ascii_hexdigit()),
        "Release identity requires a full Git commit"
    );
    println!("cargo:rustc-env=CODELIT_SOURCE_COMMIT={commit}");
    println!("cargo:rustc-env=CODELIT_SOURCE_DIRTY={dirty}");
    tauri_build::build()
}
