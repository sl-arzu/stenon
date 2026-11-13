#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use enigo::{Enigo, Keyboard, Settings};
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use stenon_core::asr::WhisperTranscriber;
use stenon_core::audio::{start_capture, to_mono_16k, Capture};
use stenon_core::config::Config;
use stenon_core::storage::db::Db;
use tauri::{AppHandle, Emitter, Manager, State};

/// Comandi per il thread di registrazione/codifica.
enum RecCommand {
    Start,
    Stop,
    /// Lingue di trascrizione ammesse (vuoto = rilevamento libero).
    SetLanguages(Vec<String>),
}

struct AppState {
    rec_tx: Sender<RecCommand>,
    db: Mutex<Db>,
    paste_mode: String,
}

#[tauri::command]
fn list_notes(state: State<AppState>) -> Vec<stenon_core::storage::db::NoteSummary> {
    state.db.lock().unwrap().list_notes()
}

#[tauri::command]
fn get_note(id: String, state: State<AppState>) -> Option<stenon_core::storage::db::NoteDetail> {
    state.db.lock().unwrap().get_note(&id)
}

#[tauri::command]
fn delete_note(id: String, state: State<AppState>) -> bool {
    state.db.lock().unwrap().delete_note(&id)
}

#[tauri::command]
fn update_note_text(id: String, text: String, state: State<AppState>) -> bool {
    state.db.lock().unwrap().update_note_text(&id, &text)
}

/// Metadati della nota (Fase B): titolo personalizzato, pin, tag.
/// Campi `None` = lasciano invariato il valore attuale.
#[tauri::command]
fn update_note_meta(
    id: String,
    title: Option<String>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
    state: State<AppState>,
) -> bool {
    let tags_json = tags
        .map(|t| serde_json::to_string(&t).unwrap_or_else(|_| "[]".to_string()));
    state
        .db
        .lock()
        .unwrap()
        .update_note_meta(&id, title.as_deref(), pinned, tags_json.as_deref())
}

/// Imposta le lingue di trascrizione ammesse a runtime.
/// Lista vuota (o contenente "auto") = rilevamento libero tra tutte le lingue.
#[tauri::command]
fn set_languages(langs: Vec<String>, state: State<AppState>) -> Result<(), String> {
    let mut langs: Vec<String> = langs
        .into_iter()
        .map(|l| l.to_lowercase())
        .filter(|l| l.len() == 2 && l.chars().all(|c| c.is_ascii_alphabetic()))
        .collect();
    langs.dedup();
    state
        .rec_tx
        .send(RecCommand::SetLanguages(langs))
        .map_err(|e| format!("worker non raggiungibile: {e}"))
}

/// Autosave del frontend: riceve l'oggetto nota completo e persiste il testo
/// ricostruito dalle passate (Fase A: solo testo; titolo/tag in Fase B).
#[tauri::command]
fn save_note(note: serde_json::Value, state: State<AppState>) -> bool {
    let Some(id) = note.get("id").and_then(|v| v.as_str()) else {
        return false;
    };
    let text = note
        .get("passes")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default();
    if text.is_empty() {
        return false;
    }
    state.db.lock().unwrap().update_note_text(id, &text)
}

/// Avvia il thread worker: possiede il modello Whisper e la cattura audio.
/// I tipi non-Send (stream cpal, contesto whisper) non attraversano mai thread.
fn spawn_recorder(config: Config, app: AppHandle) -> Sender<RecCommand> {
    let (tx, rx) = mpsc::channel::<RecCommand>();
    let db_path = Config::expand_tilde(&config.db_path);
    let model_path = Config::expand_tilde(&config.model_path);
    let language = config.language_mode.clone();
    let paste_mode = config.paste_mode.clone();
    let initial_prompt = config.initial_prompt.clone();

    std::thread::spawn(move || {
        // D11: il modello si carica all'avvio dell'app, nel thread worker
        let mut transcriber =
            match WhisperTranscriber::with_prompt(&model_path, &language, &initial_prompt) {
                Ok(t) => Some(t),
                Err(e) => {
                    eprintln!("stenon: modello non caricato ({e}): dettatura non disponibile");
                    None
                }
            };
        let mut language = language;
        // Insieme di lingue ammesse: vuoto = rilevamento libero
        let mut languages: Vec<String> = if language == "auto" {
            Vec::new()
        } else {
            vec![language.clone()]
        };
        let mut capture: Option<Capture> = None;

        for cmd in rx {
            match cmd {
                RecCommand::SetLanguages(langs) => {
                    languages = langs.clone();
                    language = langs.first().cloned().unwrap_or_else(|| "auto".to_string());
                    eprintln!("stenon: lingue ammesse: {:?}", langs);
                }
                RecCommand::Start => {
                    eprintln!("stenon: registrazione avviata");
                    if capture.is_none() {
                        match start_capture() {
                            Ok(c) => capture = Some(c),
                            Err(e) => eprintln!("stenon: cattura non avviata: {e}"),
                        }
                    }
                }
                RecCommand::Stop => {
                    eprintln!("stenon: registrazione fermata, trascrivo...");
                    let Some(cap) = capture.take() else { continue };
                    let (samples, rate, channels) = cap.stop();
                    let pcm = to_mono_16k(&samples, rate, channels);
                    let (segments, used_lang) = transcriber
                        .as_mut()
                        .map(|t| t.transcribe_constrained(&pcm, &languages))
                        .unwrap_or((Vec::new(), language.clone()));
                    if segments.is_empty() {
                        eprintln!("stenon: nessun segmento riconosciuto");
                        continue;
                    }

                    let duration_ms = (pcm.len() as i64) * 1000 / 16000;
                    if let Ok(db) = Db::open(&db_path) {
                        if let Err(e) = stenon_core::pipeline::save_dictation(
                            &db,
                            &segments,
                            &used_lang.to_uppercase(),
                            duration_ms,
                            "dettatura",
                            None,
                        ) {
                            eprintln!("stenon: salvataggio fallito: {e}");
                        }
                    }
                    let _ = app.emit("note-saved", ());

                    if paste_mode == "type" {
                        let text: String = segments
                            .iter()
                            .map(|s| s.text.as_str())
                            .collect::<Vec<_>>()
                            .join(" ");
                        let mut enigo = match Enigo::new(&Settings::default()) {
                            Ok(e) => e,
                            Err(e) => {
                                eprintln!("stenon: enigo non disponibile: {e}");
                                continue;
                            }
                        };
                        if let Err(e) = enigo.text(&text) {
                            eprintln!("stenon: incolla fallito: {e}");
                        }
                    }
                }
            }
        }
    });
    tx
}

fn main() {
    let config = Config::load_or_default(std::path::Path::new("config.toml"));
    let db_path = Config::expand_tilde(&config.db_path);
    let db = Db::open(&db_path).expect("impossibile aprire il database");
    let paste_mode = config.paste_mode.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let rec_tx = spawn_recorder(config, app.handle().clone());
            app.manage(AppState {
                rec_tx,
                db: Mutex::new(db),
                paste_mode,
            });

            // hotkey globale push-to-talk (Ctrl+Shift+Space)
            let manager = GlobalHotKeyManager::new()?;
            manager.register(HotKey::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::Space,
            ))?;
            std::mem::forget(manager); // deve vivere quanto il processo

            // thread che inoltra gli eventi hotkey al worker
            let tx = app.state::<AppState>().rec_tx.clone();
            std::thread::spawn(move || loop {
                match GlobalHotKeyEvent::receiver().recv() {
                    Ok(event) => {
                        let cmd = match event.state {
                            HotKeyState::Pressed => RecCommand::Start,
                            HotKeyState::Released => RecCommand::Stop,
                        };
                        let _ = tx.send(cmd);
                    }
                    Err(_) => break,
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            get_note,
            delete_note,
            update_note_text,
            update_note_meta,
            save_note,
            set_languages
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'esecuzione di Stenon");
}
