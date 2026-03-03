/// Zed extension for the Arturo programming language
///
/// The LSP server (arturo-lsp) is fetched from npm at install time.
/// Zed's npm_install_package API handles downloading and caching.

use zed_extension_api::{self as zed, LanguageServerId, Result};

struct ArturoExtension {
    cached_server_path: Option<String>,
}

impl zed::Extension for ArturoExtension {
    fn new() -> Self {
        Self {
            cached_server_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(language_server_id)?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path, "--stdio".to_string()],
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

impl ArturoExtension {
    fn server_script_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        // Return cached path if the file still exists on disk.
        if let Some(path) = &self.cached_server_path {
            if std::fs::metadata(path).is_ok() {
                return Ok(path.clone());
            }
        }

        // Signal to Zed that we are checking for an update.
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        // Fetch the latest published version of arturo-lsp from npm.
        let latest_version = zed::npm_package_latest_version("arturo-lsp")?;

        // Skip re-installing if the installed version is already current.
        let needs_install = match zed::npm_package_installed_version("arturo-lsp") {
            Ok(Some(installed)) => installed != latest_version,
            _ => true,
        };

        if needs_install {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            zed::npm_install_package("arturo-lsp", &latest_version)?;
        }

        // npm_install_package installs into node_modules/ relative to the
        // extension's working directory (set by register_extension! to PWD).
        let path = "node_modules/arturo-lsp/server.js".to_string();

        self.cached_server_path = Some(path.clone());
        Ok(path)
    }
}

zed::register_extension!(ArturoExtension);
