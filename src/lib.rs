/// Zed extension for Arturo programming language
///
/// This extension provides language support for Arturo, including:
/// - Syntax highlighting via Tree-sitter
/// - Type checking based on Arturo's type system
/// - Go-to-definition for functions and variables
/// - Hover information for types and documentation
///
/// # Architecture
///
/// The language server is downloaded from npm as `arturo-lsp` and run via Node.js.

use zed_extension_api::{self as zed, LanguageServerId, Result};

const PACKAGE_NAME: &str = "arturo-lsp";
const SERVER_PATH: &str = "node_modules/.bin/arturo-lsp";

struct ArturoExtension {
    did_install: bool,
}

impl zed::Extension for ArturoExtension {
    fn new() -> Self {
        Self { did_install: false }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if !self.did_install {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::CheckingForUpdate,
            );

            let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
            let latest_version = zed::npm_package_latest_version(PACKAGE_NAME)?;

            if installed_version.as_deref() != Some(&latest_version) {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                zed::npm_install_package(PACKAGE_NAME, &latest_version)?;
            }

            self.did_install = true;
        }

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
            "typeChecking": true,
            "definitions": true,
            "hover": true,
        })))
    }
}

zed::register_extension!(ArturoExtension);
