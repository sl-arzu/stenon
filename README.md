# Stenon

**Push-to-talk voice dictation for macOS.** Hold a hotkey, speak, release — the
text appears in whatever field you were typing in. 100% local: no cloud, no API
keys, no telemetry. Built with Tauri 2 and whisper.cpp.

## Why

I wanted dictation that never leaves my machine. Existing tools either require
subscriptions, ship audio to third parties, or are Electron apps that eat
300 MB of RAM. Stenon is a single native-ish window around a Rust core, with
on-device Whisper transcription.

## How it works

```
┌─────────────┐    mpsc     ┌──────────────────────────────┐
│ Global      │──Start/Stop▶│ Worker thread                │
│ hotkey      │             │  cpal capture (mic, 16 kHz)  │
│ (Ctrl+⇧+␣)  │             │  whisper.cpp transcription   │
└─────────────┘             │  SQLite persistence          │
                            └─────────────┬────────────────┘
                                          │ paste (CGEvent/enigo)
                              ▼ active text field
```

- **`crates/stenon-core`** — headless library: audio capture (cpal), Whisper
  transcription (whisper-rs), SQLite storage, dictation pipeline.
- **`apps/desktop`** — Tauri 2 shell: global hotkey, note list UI, paste into
  the active field.
- Non-`Send` types (cpal stream, whisper context) never cross threads: capture
  and transcription live entirely in the worker.

## Build

Requirements: Rust, CMake (for whisper.cpp), a Whisper ggml model.

```sh
# 1. Build
cargo build --release

# 2. Download a model (base is a good default, ~142 MB)
./scripts/fetch-model.sh base

# 3. Configure
cp config.example.toml config.toml   # then edit model_path if needed

# 4. Run
cargo run -p stenon-desktop
```

## Configuration

`config.toml` (see `config.example.toml`):

| Key | Meaning |
|---|---|
| `model_path` | Path to the ggml model |
| `language_mode` | `"auto"` or an ISO code (`it`, `en`, …) |
| `initial_prompt` | Comma-separated vocabulary hints for the model |
| `hotkey` | Push-to-talk shortcut (default `Ctrl+Shift+Space`) |
| `paste_mode` | `"type"` (simulated typing) or `"clipboard"` |

## Roadmap

- [x] Phase 0 — skeleton: hotkey → capture → transcribe → paste
- [ ] Model switching (small/large) from the UI
- [ ] Vocabulary editor in the app (add/remove terms without editing TOML)
- [ ] Transcription editing (fix a wrong word inline)
- [ ] Merge consecutive dictations into the same note
- [ ] Metal GPU acceleration (currently CPU/BLAS)

## License

MIT
