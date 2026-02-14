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
/// The extension bundles a Node.js-based language server as bundle.js embedded
/// directly in the extension binary. On first use, the bundle is written to disk
/// in Zed's cache directory and then executed.

use zed_extension_api::{self as zed, LanguageServerId, Result, settings::LspSettings};
use std::fs;

// Embed the language server bundle at compile time
const LANGUAGE_SERVER_BUNDLE: &str = include_str!("../bundle.js");

struct ArturoExtension {
    /// Cached language server binary path
    cached_binary_path: Option<String>,
}

impl zed::Extension for ArturoExtension {
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.language_server_script_path(language_server_id)?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_path,
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        // Read settings from Zed's configuration
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.settings.clone())
            .unwrap_or_default();
        
        // Pass settings through to the LSP server
        Ok(Some(zed::serde_json::json!({
            "settings": settings
        })))
    }
}

impl ArturoExtension {
    fn language_server_script_path(
        &mut self,
        language_server_id: &LanguageServerId,
    ) -> Result<String> {
        // Check if we already have a cached path
        if let Some(path) = &self.cached_binary_path {
            if fs::metadata(path).is_ok() {
                return Ok(path.clone());
            }
        }
        
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        
        // Use current directory (the extension's working directory in Zed)
        // Zed sets this to a writable location
        let current_dir = std::env::current_dir()
            .map_err(|e| format!("Failed to get current directory: {}", e))?;
        
        let bundle_path = current_dir.join("arturo-lsp-bundle.js");
        
        // Write the embedded bundle to disk
        // We write it every time to ensure it's always up to date with the extension
        fs::write(&bundle_path, LANGUAGE_SERVER_BUNDLE)
            .map_err(|e| format!("Failed to write language server bundle: {}", e))?;
        
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        
        let bundle_path_str = bundle_path
            .to_str()
            .ok_or("Failed to convert path to string")?
            .to_string();
        
        self.cached_binary_path = Some(bundle_path_str.clone());
        Ok(bundle_path_str)
    }
}

zed::register_extension!(ArturoExtension);
