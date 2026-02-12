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
/// The extension bundles a Node.js-based language server as a single bundle.js file.
/// All dependencies are pre-bundled using esbuild, so no npm installation is required.
/// This makes the extension faster to load and eliminates dependency management issues.

use zed_extension_api::{self as zed, LanguageServerId, Result};
use std::fs;
use std::path::PathBuf;

struct ArturoExtension {
    /// Cached language server binary path
    cached_binary_path: Option<String>,
}

impl zed::Extension for ArturoExtension {
    /// Creates a new instance of the Arturo extension
    /// 
    /// # Returns
    /// 
    /// A new `ArturoExtension` instance with no cached binary path
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    /// Returns the command to start the Arturo language server
    /// 
    /// This method is called by Zed when it needs to start a language server
    /// for an Arturo file. It ensures npm dependencies are installed and
    /// returns the command to execute the language server.
    /// 
    /// # Arguments
    /// 
    /// * `language_server_id` - The ID of the language server to start
    /// * `worktree` - The worktree where the server should run
    /// 
    /// # Returns
    /// 
    /// A `Result` containing the `Command` to execute the language server
    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.language_server_script_path(language_server_id)?;

        // Diagnostic logging
        eprintln!("=== ARTURO LSP DEBUG ===");
        eprintln!("Server path: {}", server_path);
        eprintln!("Current dir: {:?}", std::env::current_dir());
        eprintln!("File exists: {}", fs::metadata(&server_path).is_ok());
        eprintln!("=======================");

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_path,
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }

    /// Returns initialization options for the language server
    /// 
    /// These options are sent to the language server during initialization
    /// to configure its behavior.
    /// 
    /// # Arguments
    /// 
    /// * `language_server_id` - The ID of the language server
    /// * `worktree` - The worktree context
    /// 
    /// # Returns
    /// 
    /// Optional JSON value containing initialization options
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

impl ArturoExtension {
    /// Gets the path to the bundled language server script
    /// 
    /// Returns the path to bundle.js which contains the language server and all
    /// its dependencies in a single file. No npm installation is required.
    /// 
    /// # Arguments
    /// 
    /// * `language_server_id` - The ID of the language server (unused)
    /// 
    /// # Returns
    /// 
    /// A `Result` containing the path to the bundled language server script
    fn language_server_script_path(
        &mut self,
        language_server_id: &LanguageServerId,
    ) -> Result<String> {
        // Use the bundled language server - no npm installation needed!
        // The bundle.js file contains all dependencies built-in.
        
        if let Some(path) = &self.cached_binary_path {
            if fs::metadata(path).is_ok() {
                return Ok(path.clone());
            }
        }
        
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        
        // Try multiple possible locations
        let current_dir = std::env::current_dir()
            .map_err(|e| format!("Failed to get current directory: {}", e))?;
        
        let mut possible_paths: Vec<PathBuf> = Vec::new();
        
        // Path 1: bundle.js in the root of the extension
        possible_paths.push(current_dir.join("bundle.js"));
        
        // Path 2: Legacy location (language-server/bundle.js)
        possible_paths.push(current_dir.join("language-server").join("bundle.js"));
        
        // Path 3: Executable directory + bundle.js
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                possible_paths.push(exe_dir.join("bundle.js"));
            }
        }
        
        eprintln!("=== SEARCHING FOR BUNDLE.JS ===");
        eprintln!("Current dir: {:?}", current_dir);
        
        for (i, path) in possible_paths.iter().enumerate() {
            eprintln!("Path {}: {}", i, path.display());
            eprintln!("  Exists: {}", fs::metadata(path).is_ok());
            
            if fs::metadata(path).is_ok() {
                let path_str = path
                    .to_str()
                    .ok_or("Failed to convert path to string")?
                    .to_string();
                
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::CheckingForUpdate,
                );
                
                self.cached_binary_path = Some(path_str.clone());
                eprintln!("FOUND IT: {}", path_str);
                eprintln!("===============================");
                return Ok(path_str);
            }
        }
        
        eprintln!("===============================");
        
        let paths_searched = possible_paths
            .iter()
            .map(|p| format!("  - {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        
        Err(format!(
            "Language server bundle not found. Searched:\n{}\nCurrent dir: {:?}",
            paths_searched,
            current_dir
        ))
    }
}

zed::register_extension!(ArturoExtension);
