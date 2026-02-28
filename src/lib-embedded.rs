/// Zed extension for the Arturo programming language — embedded bundle build
///
/// The entire LSP server (server.js + node_modules) has been bundled by webpack
/// into bundle.js and embedded into this WASM binary via include_str!.
/// On first use the bundle is extracted to the system temp directory and Node
/// is pointed at that file — fully cross-platform, no extension directory needed.

use zed_extension_api::{self as zed, LanguageServerId, Result};

/// The bundled LSP server, compiled into the WASM binary at build time.
const BUNDLE: &str = include_str!("../bundle.js");

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
            // Use std::env::temp_dir() for a cross-platform writable temp path.
            // On Windows this is %TEMP% (e.g. C:\Users\<user>\AppData\Local\Temp).
            // On macOS/Linux this is /tmp or $TMPDIR.
            let tmp = std::env::temp_dir();
            let path = tmp.join("arturo-lsp-bundle.js");
            std::fs::write(&path, BUNDLE)
                .map_err(|e| format!("Failed to write arturo-lsp bundle to {}: {}", path.display(), e))?;
            self.bundle_path = Some(path.to_string_lossy().into_owned());
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
