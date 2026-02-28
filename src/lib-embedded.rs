/// Zed extension for the Arturo programming language — embedded bundle build
///
/// The LSP server (language-server/server.js + node_modules) has been bundled
/// by webpack into bundle.js and embedded into this WASM binary via include_str!.
///
/// On first use the bundle is written to the extension's working directory.
/// Zed injects a PWD environment variable into the WASM sandbox pointing to
/// the extension's own writable work directory (and also sets CWD to it via
/// the register_extension! macro). We read PWD to build the absolute host path
/// that Node needs, since Node is spawned with the open project as its CWD.

use zed_extension_api::{self as zed, LanguageServerId, Result};

/// The bundled LSP server, compiled into the WASM binary at build time.
const BUNDLE: &str = include_str!("../bundle.js");

/// Filename written inside the extension's work directory.
const BUNDLE_FILENAME: &str = "arturo-lsp-bundle.js";

struct ArturoExtension {
    bundle_path: Option<String>,
}

impl zed::Extension for ArturoExtension {
    fn new() -> Self {
        Self { bundle_path: None }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if self.bundle_path.is_none() {
            // Zed sets PWD to the extension's writable work directory before
            // invoking the WASM. This gives us the absolute host path we need
            // to pass to Node (which runs outside the WASI sandbox).
            let work_dir = std::env::var("PWD")
                .map_err(|_| "PWD environment variable not set by Zed".to_string())?;

            // Write using a relative path — the WASI sandbox only permits
            // writes relative to CWD, not via absolute host paths.
            std::fs::write(BUNDLE_FILENAME, BUNDLE)
                .map_err(|e| format!("Failed to write arturo-lsp bundle: {}", e))?;

            // Build the absolute host path (for Node) from PWD + filename.
            let path = format!("{}/{}", work_dir.trim_end_matches('/'), BUNDLE_FILENAME);
            self.bundle_path = Some(path);
        }

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                self.bundle_path.clone().unwrap(),
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(Some(zed::serde_json::json!({
            "settings": {
                "completion":         "on",
                "signatures":         "on",
                "formatting":         "on",
                "highlights":         "on",
                "advancedServerLogs": "off"
            }
        })))
    }
}

zed::register_extension!(ArturoExtension);
