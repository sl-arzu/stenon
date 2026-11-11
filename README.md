# Stenon

Dettatura vocale locale per macOS: tieni premuto `Ctrl+Shift+Spazio`, parla,
rilascia e il testo viene incollato nel campo attivo. Tutto in locale, nessun
servizio cloud.

## Architettura

- **`crates/stenon-core`** — logica headless: cattura audio (cpal), trascrizione
  Whisper (whisper-rs), persistenza SQLite, pipeline di salvataggio.
- **`apps/desktop`** — guscio Tauri 2: hotkey globale push-to-talk, incolla nel
  campo attivo, lista note con eliminazione (con conferma).

## Requisiti

- Rust (cargo/rustc)
- CMake (per compilare whisper.cpp)
- Un modello Whisper.cpp in formato ggml (es. `ggml-base-it.bin`)

## Build

```sh
cargo build --release
```

## Configurazione

Copia `config.example.toml` in `config.toml` e adatta i percorsi:

```toml
model_path = "~/.local/share/stenon/models/ggml-base-it.bin"
language = "it"
hotkey = "Ctrl+Shift+Space"
paste_mode = "type"   # oppure "clipboard"
db_path = "~/.local/share/stenon/notes.db"
```

## Uso

1. Avvia l'app: `cargo run -p stenon-desktop`.
2. Tieni premuto `Ctrl+Shift+Spazio` e parla.
3. Al rilascio la nota viene trascritta, salvata e incollata nel campo attivo.
