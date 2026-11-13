#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use enigo::{Enigo, Keyboard, Settings};
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use stenon_core::asr::{trim_silence_edges, Segment, WhisperTranscriber};
use stenon_core::audio::{start_capture, to_mono_16k, Capture};
use stenon_core::config::Config;
use stenon_core::storage::db::Db;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use stenon_core::audio::loopback::{start_loopback, LoopbackCapture};

/// Comandi per il thread di registrazione/codifica.
enum RecCommand {
    Start,
    Stop,
    /// Lingue di trascrizione ammesse (vuoto = rilevamento libero).
    SetLanguages(Vec<String>),
    /// Fase C: avvia la riunione (mic + loopback di sistema).
    MeetingStart,
    /// Fase C: ferma la riunione, salva audio e note.
    MeetingStop,
    /// Fase C: pausa — i blocchi in pausa non vengono registrati.
    MeetingPause,
    /// Fase C: riprende dopo la pausa.
    MeetingResume,
}

/// Durata del blocco live di una traccia in riunione (secondi).
const MEETING_CHUNK_SECS: usize = 8;

/// Stato di una riunione in corso (Fase C). Solo macOS: il loopback SCK
/// non esiste altrove; su altri target la riunione resta mic-only (Fase D+).
struct MeetingLive {
    mic: Capture,
    mic_consumed: usize,
    mic_segments: Vec<Segment>,
    paused: bool,
    #[cfg(target_os = "macos")]
    sys: Option<LoopbackCapture>,
    #[cfg(target_os = "macos")]
    sys_consumed: usize,
    #[cfg(target_os = "macos")]
    sys_segments: Vec<Segment>,
}

impl MeetingLive {
    fn new(mic: Capture) -> Self {
        Self {
            mic,
            mic_consumed: 0,
            mic_segments: Vec::new(),
            paused: false,
            #[cfg(target_os = "macos")]
            sys: None,
            #[cfg(target_os = "macos")]
            sys_consumed: 0,
            #[cfg(target_os = "macos")]
            sys_segments: Vec::new(),
        }
    }
}

/// Trascrive un blocco mono 16 kHz e riallinea i timestamp all'offset del blocco.
fn transcribe_meeting_chunk(
    transcriber: Option<&mut WhisperTranscriber>,
    fallback_lang: &str,
    pcm: &[f32],
    offset_ms: i64,
    languages: &[String],
) -> Vec<Segment> {
    let pcm = trim_silence_edges(pcm);
    let (mut segs, _lang) = transcriber
        .map(|t| t.transcribe_constrained(pcm, languages))
        .unwrap_or((Vec::new(), fallback_lang.to_string()));
    for s in &mut segs {
        s.start_ms += offset_ms;
        s.end_ms += offset_ms;
    }
    segs
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
    let tags_json = tags.map(|t| serde_json::to_string(&t).unwrap_or_else(|_| "[]".to_string()));
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

/// Fase C: avvia la riunione (mic + loopback di sistema).
#[tauri::command]
fn start_meeting(state: State<AppState>) -> Result<(), String> {
    state
        .rec_tx
        .send(RecCommand::MeetingStart)
        .map_err(|e| format!("worker non raggiungibile: {e}"))
}

/// Fase C: ferma la riunione, salva audio e nota, emette note-saved.
#[tauri::command]
fn stop_meeting(state: State<AppState>) -> Result<(), String> {
    state
        .rec_tx
        .send(RecCommand::MeetingStop)
        .map_err(|e| format!("worker non raggiungibile: {e}"))
}

/// Fase C: pausa riunione (i blocchi in pausa non vengono registrati).
#[tauri::command]
fn pause_meeting(state: State<AppState>) -> Result<(), String> {
    state
        .rec_tx
        .send(RecCommand::MeetingPause)
        .map_err(|e| format!("worker non raggiungibile: {e}"))
}

/// Fase C: riprende la riunione.
#[tauri::command]
fn resume_meeting(state: State<AppState>) -> Result<(), String> {
    state
        .rec_tx
        .send(RecCommand::MeetingResume)
        .map_err(|e| format!("worker non raggiungibile: {e}"))
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
        let mut meeting: Option<MeetingLive> = None;

        // Loop: mentre una riunione è in corso polleniamo ogni 400 ms per
        // trascrivere i blocchi live; altrimenti recv bloccante (zero CPU).
        loop {
            let cmd = if meeting.is_some() {
                match rx.recv_timeout(std::time::Duration::from_millis(400)) {
                    Ok(cmd) => Some(cmd),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            } else {
                match rx.recv() {
                    Ok(cmd) => Some(cmd),
                    Err(_) => break,
                }
            };
            match cmd {
                None => {
                    // Tick riunione: trascrivi i blocchi pronti per ogni traccia.
                    if let Some(m) = meeting.as_mut() {
                        meeting_tick(m, transcriber.as_mut(), &language, &languages, &app);
                    }
                }
                Some(cmd) => handle_command(
                    cmd,
                    &mut transcriber,
                    &mut language,
                    &mut languages,
                    &mut capture,
                    &mut meeting,
                    &app,
                    &db_path,
                    &paste_mode,
                ),
            }
        }
    });
    tx
}

/// Gestisce un comando del worker (dettatura + riunione, Fase C).
fn handle_command(
    cmd: RecCommand,
    transcriber: &mut Option<WhisperTranscriber>,
    language: &mut String,
    languages: &mut Vec<String>,
    capture: &mut Option<Capture>,
    meeting: &mut Option<MeetingLive>,
    app: &AppHandle,
    db_path: &std::path::Path,
    paste_mode: &str,
) {
    match cmd {
        RecCommand::SetLanguages(langs) => {
            *languages = langs.clone();
            *language = langs.first().cloned().unwrap_or_else(|| "auto".to_string());
            eprintln!("stenon: lingue ammesse: {:?}", langs);
        }
        // Hotkey ignorata durante una riunione: evita dettature parallele
        // che confondono lo stato (la voce va nella riunione, non in note a parte).
        RecCommand::Start | RecCommand::Stop if meeting.is_some() => {
            eprintln!("stenon: hotkey ignorata: riunione in corso");
        }
        RecCommand::Start => {
            eprintln!("stenon: registrazione avviata");
            if capture.is_none() {
                match start_capture() {
                    Ok(c) => *capture = Some(c),
                    Err(e) => eprintln!("stenon: cattura non avviata: {e}"),
                }
            }
        }
        RecCommand::Stop => {
            eprintln!("stenon: registrazione fermata, trascrivo...");
            let Some(cap) = capture.take() else { return };
            let (samples, rate, channels) = cap.stop();
            let pcm = to_mono_16k(&samples, rate, channels);
            let (segments, used_lang) = transcriber
                .as_mut()
                .map(|t| t.transcribe_constrained(&pcm, languages))
                .unwrap_or((Vec::new(), language.clone()));
            if segments.is_empty() {
                eprintln!("stenon: nessun segmento riconosciuto");
                return;
            }

            let duration_ms = (pcm.len() as i64) * 1000 / 16000;
            if let Ok(db) = Db::open(db_path) {
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
                        return;
                    }
                };
                if let Err(e) = enigo.text(&text) {
                    eprintln!("stenon: incolla fallito: {e}");
                }
            }
        }
        RecCommand::MeetingStart => {
            eprintln!("stenon: riunione avviata");
            // La dettatura in corso cede il microfono.
            *capture = None;
            match start_capture() {
                Ok(mic) => {
                    let mut m = MeetingLive::new(mic);
                    #[cfg(target_os = "macos")]
                    match start_loopback() {
                        Ok(l) => m.sys = Some(l),
                        Err(e) => {
                            // Onesto: prosegue mic-only e l'UI lo comunica.
                            eprintln!("stenon: loopback non disponibile: {e}");
                            let _ = app.emit("meeting-permission", e);
                        }
                    }
                    *meeting = Some(m);
                }
                Err(e) => {
                    let _ = app.emit("meeting-permission", format!("mic: {e}"));
                }
            }
        }
        RecCommand::MeetingStop => {
            let Some(m) = meeting.take() else { return };
            eprintln!("stenon: riunione fermata, salvo...");
            finish_meeting(m, transcriber, language, languages, app, db_path);
        }
        RecCommand::MeetingPause => {
            if let Some(m) = meeting.as_mut() {
                m.paused = true;
                eprintln!("stenon: riunione in pausa");
            }
        }
        RecCommand::MeetingResume => {
            if let Some(m) = meeting.as_mut() {
                m.paused = false;
                eprintln!("stenon: riunione ripresa");
            }
        }
    }
}

/// Emette un utterance live all'UI (evento Tauri `meeting-chunk`).
fn emit_chunk(app: &AppHandle, track: &str, s: &Segment) {
    let _ = app.emit(
        "meeting-chunk",
        serde_json::json!({
            "track": track,
            "start_ms": s.start_ms,
            "end_ms": s.end_ms,
            "text": s.text,
            "lang": s.lang,
        }),
    );
}

/// Tick riunione: per ogni traccia con ≥ MEETING_CHUNK_SECS di audio nuovo,
/// trascrive il blocco, lo accumula e lo emette all'UI come utterance live.
fn meeting_tick(
    m: &mut MeetingLive,
    mut transcriber: Option<&mut WhisperTranscriber>,
    fallback_lang: &str,
    languages: &[String],
    app: &AppHandle,
) {
    if m.paused {
        // In pausa: l'audio non viene accumulato né trascritto (onesto).
        // Scarta l'audio accumulato finora così la ripresa parte pulita.
        m.mic_consumed = m.mic.snapshot().len();
        #[cfg(target_os = "macos")]
        if let Some(lb) = m.sys.as_ref() {
            m.sys_consumed = lb.snapshot().len();
        }
        return;
    }
    // --- microfono (cpal) ---
    let raw = m.mic.snapshot();
    let rate = m.mic.input_rate() as usize;
    let ch = m.mic.channels().max(1);
    let sec_samples = rate * ch;
    let pending = raw.len().saturating_sub(m.mic_consumed);
    if sec_samples > 0 && pending >= MEETING_CHUNK_SECS * sec_samples {
        let take = (pending / sec_samples) * sec_samples;
        let chunk = &raw[m.mic_consumed..m.mic_consumed + take];
        let offset_ms = (m.mic_consumed as i64) * 1000 / (sec_samples as i64);
        m.mic_consumed += take;
        let pcm = to_mono_16k(chunk, rate as u32, ch);
        let segs = transcribe_meeting_chunk(
            transcriber.as_deref_mut(),
            fallback_lang,
            &pcm,
            offset_ms,
            languages,
        );
        for s in &segs {
            m.mic_segments.push(s.clone());
            emit_chunk(app, "mic", s);
        }
    }

    // --- sistema (SCK loopback, solo macOS) ---
    #[cfg(target_os = "macos")]
    if let Some(lb) = m.sys.as_ref() {
        let raw = lb.snapshot();
        let rate = lb.rate() as usize;
        let ch = lb.channels().max(1);
        let sec_samples = rate * ch;
        let pending = raw.len().saturating_sub(m.sys_consumed);
        if sec_samples > 0 && pending >= MEETING_CHUNK_SECS * sec_samples {
            let take = (pending / sec_samples) * sec_samples;
            let chunk = &raw[m.sys_consumed..m.sys_consumed + take];
            let offset_ms = (m.sys_consumed as i64) * 1000 / (sec_samples as i64);
            m.sys_consumed += take;
            let pcm = to_mono_16k(chunk, rate as u32, ch);
            let segs =
                transcribe_meeting_chunk(transcriber, fallback_lang, &pcm, offset_ms, languages);
            for s in &segs {
                m.sys_segments.push(s.clone());
                emit_chunk(app, "system", s);
            }
        }
    }
}

/// Ferma la riunione: flush finale, WAV per traccia (D7), nota + tracce +
/// segmenti nel DB, evento note-saved.
fn finish_meeting(
    mut m: MeetingLive,
    transcriber: &mut Option<WhisperTranscriber>,
    language: &str,
    languages: &[String],
    app: &AppHandle,
    db_path: &std::path::Path,
) {
    // Flush dei residui (≥ 0,5 s) prima di fermare le catture.
    let mic_raw = m.mic.snapshot();
    let mic_rate = m.mic.input_rate();
    let mic_ch = m.mic.channels().max(1);
    let mic_pending = mic_raw.len().saturating_sub(m.mic_consumed);
    let mic_sec = mic_rate as usize * mic_ch;
    if mic_sec > 0 && mic_pending >= mic_sec / 2 {
        let chunk = &mic_raw[m.mic_consumed..];
        let offset_ms = (m.mic_consumed as i64) * 1000 / (mic_sec as i64);
        let pcm = to_mono_16k(chunk, mic_rate, mic_ch);
        let segs =
            transcribe_meeting_chunk(transcriber.as_mut(), language, &pcm, offset_ms, languages);
        for s in &segs {
            m.mic_segments.push(s.clone());
            emit_chunk(app, "mic", s);
        }
    }
    let (mic_full, _, _) = m.mic.stop();

    #[cfg(target_os = "macos")]
    let (sys_full, sys_rate, sys_ch) = match m.sys.take() {
        Some(lb) => {
            let raw = lb.snapshot();
            let rate = lb.rate();
            let ch = lb.channels().max(1);
            let pending = raw.len().saturating_sub(m.sys_consumed);
            let sec = rate as usize * ch;
            if sec > 0 && pending >= sec / 2 {
                let chunk = &raw[m.sys_consumed..];
                let offset_ms = (m.sys_consumed as i64) * 1000 / (sec as i64);
                let pcm = to_mono_16k(chunk, rate, ch);
                let segs = transcribe_meeting_chunk(
                    transcriber.as_mut(),
                    language,
                    &pcm,
                    offset_ms,
                    languages,
                );
                for s in &segs {
                    m.sys_segments.push(s.clone());
                    emit_chunk(app, "system", s);
                }
            }
            lb.stop()
        }
        None => (Vec::new(), 48_000, 1),
    };

    let mic_pcm = to_mono_16k(&mic_full, mic_rate, mic_ch);
    #[cfg(target_os = "macos")]
    let sys_pcm = to_mono_16k(&sys_full, sys_rate, sys_ch);

    let duration_ms = {
        let mic_ms = (mic_pcm.len() as i64) * 1000 / 16000;
        #[cfg(target_os = "macos")]
        let sys_ms = (sys_pcm.len() as i64) * 1000 / 16000;
        #[cfg(not(target_os = "macos"))]
        let sys_ms = 0;
        mic_ms.max(sys_ms)
    };

    // Lingua della nota: la lingua fissata se c'è, altrimenti AUTO.
    let note_lang = if languages.len() == 1 {
        languages[0].to_uppercase()
    } else {
        "AUTO".to_string()
    };
    let _ = language;

    // Cartella audio accanto al DB (D7).
    let audio_dir = std::path::Path::new(db_path)
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("audio");
    let _ = std::fs::create_dir_all(&audio_dir);

    let mut tracks = vec![stenon_core::pipeline::MeetingTrack {
        kind: "mic".to_string(),
        label: "Microfono".to_string(),
        segments: m.mic_segments.clone(),
    }];
    #[cfg(target_os = "macos")]
    tracks.push(stenon_core::pipeline::MeetingTrack {
        kind: "system".to_string(),
        label: "Sistema".to_string(),
        segments: m.sys_segments.clone(),
    });

    let saved = std::path::Path::new(db_path)
        .parent()
        .and_then(|_| Db::open(db_path).ok());
    match saved {
        Some(db) => {
            match stenon_core::pipeline::save_meeting(
                &db,
                &tracks,
                &note_lang,
                duration_ms,
                Some(&audio_dir.to_string_lossy()),
            ) {
                Ok(note_id) => {
                    // WAV per traccia (16 kHz mono, pcm16).
                    let mic_path = audio_dir.join(format!("{note_id}-mic.wav"));
                    if let Err(e) = stenon_core::audio::wav::write_wav_16k_mono(&mic_path, &mic_pcm)
                    {
                        eprintln!("stenon: wav mic non salvato: {e}");
                    }
                    #[cfg(target_os = "macos")]
                    if !sys_pcm.is_empty() {
                        let sys_path = audio_dir.join(format!("{note_id}-system.wav"));
                        if let Err(e) =
                            stenon_core::audio::wav::write_wav_16k_mono(&sys_path, &sys_pcm)
                        {
                            eprintln!("stenon: wav sistema non salvato: {e}");
                        }
                    }
                    let _ = app.emit("note-saved", ());
                }
                Err(e) => {
                    eprintln!("stenon: salvataggio riunione fallito: {e}");
                    let _ = app.emit("meeting-error", format!("salvataggio: {e}"));
                }
            }
        }
        None => {
            let _ = app.emit("meeting-error", "database non disponibile".to_string());
        }
    }
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
            set_languages,
            start_meeting,
            pause_meeting,
            resume_meeting,
            stop_meeting
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'esecuzione di Stenon");
}
