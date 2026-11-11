//! Configurazione applicativa (config.toml).

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Configurazione dell'app, caricata da `config.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Scorciatoia globale push-to-talk (es. "Ctrl+Shift+Space").
    pub hotkey: String,
    /// Percorso del modello Whisper ggml.
    pub model_path: String,
    /// Percorso del database SQLite delle note.
    pub db_path: String,
    /// Lingua per l'ASR: "auto" oppure codice ISO (it, en, fr, ja).
    pub language_mode: String,
    /// Modalità di inserimento del testo: "type" (digitazione) o "clipboard".
    pub paste_mode: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: "Ctrl+Shift+Space".to_string(),
            model_path: String::new(),
            db_path: "~/Library/Application Support/Stenon/notes.db".to_string(),
            language_mode: "auto".to_string(),
            paste_mode: "type".to_string(),
        }
    }
}

impl Config {
    /// Carica la configurazione da un file TOML.
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        toml::from_str(&raw).map_err(|e| e.to_string())
    }

    /// Carica la configurazione, con fallback ai valori predefiniti.
    pub fn load_or_default(path: &Path) -> Self {
        Self::load(path).unwrap_or_default()
    }

    /// Espande `~` nei percorsi configurati.
    pub fn expand_tilde(p: &str) -> PathBuf {
        if let Some(rest) = p.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home).join(rest);
            }
        }
        PathBuf::from(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let c = Config::default();
        assert_eq!(c.hotkey, "Ctrl+Shift+Space");
        assert_eq!(c.language_mode, "auto");
        assert_eq!(c.paste_mode, "type");
    }

    #[test]
    fn parses_toml() {
        let raw = r#"
hotkey = "Ctrl+Shift+Space"
model_path = "models/ggml-base.bin"
db_path = "~/Library/Application Support/Stenon/notes.db"
language_mode = "auto"
paste_mode = "type"
"#;
        let c: Config = toml::from_str(raw).unwrap();
        assert_eq!(c.hotkey, "Ctrl+Shift+Space");
        assert_eq!(c.language_mode, "auto");
    }
}
