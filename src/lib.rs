/// Zed extension for the Arturo programming language
///
/// Launches the bundled LSP server (language-server/server.js) directly via
/// the Node.js binary provided by Zed. The path is resolved relative to the
/// extension's work directory by Zed's host process — no temp file extraction
/// needed, and this works correctly on all platforms including Windows.

use zed_extension_api::{self as zed, LanguageServerId, Result};

/// Path to the LSP entry point, relative to the extension root.
const SERVER_PATH: &str = "language-server/server.js";

struct ArturoExtension;

impl zed::Extension for ArturoExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                SERVER_PATH.to_string(),
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
