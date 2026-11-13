# Fase C — Modalità riunione multicanale

Contratto per la Fase C del progetto Stenon (rif. PROGETTO.md §3, R9; D7).
Nota: la cartella canonica delle specifiche è `~/Sync/scambio/pronti/stenon/per-pi/`
(qui ne va tenuta una copia sincronizzata nel repo).

## Obiettivo

Registrazione riunioni con **due tracce simultanee**:

- `mic` — microfono di default (cpal, già esistente)
- `system` — audio di sistema via **ScreenCaptureKit** (loopback, macOS 13+;
  esclude l'audio prodotto da Stenon stesso)

## Requisiti

1. **R9**: note di modalità `riunione` con più tracce; testo unico tipo chat,
   segmenti etichettati per traccia (🎤 Microfono / 💻 Sistema).
2. **D7**: l'audio della riunione viene salvato su disco (WAV 16 kHz mono per
   traccia, in `~/.local/share/stenon/audio/<note_id>-<traccia>.wav`);
   `audio_path` = cartella delle tracce.
3. **D5 invarianti**: `segments` non si modifica mai; testo modificato va in `versions`.
4. **Live**: durante la riunione l'UI mostra gli utterance man mano (chunk di ~8 s
   per traccia, trascrizione con vincolo lingue corrente, evento `meeting-chunk`).
5. **Permessi**: Screen Recording richiesto da SCK anche per audio-only. Se mancante,
   l'app lo comunica onestamente (nessuna simulazione) e indica dove concederlo.
6. **Stop**: flush finale, salvataggio WAV + note + 2 tracce + segmenti + version raw,
   evento `note-saved`; la nota appare completa nella lista.

## Non obiettivi (Fasi successive)

- Diarizzazione parlanti (Fase D) — le "voci" ora sono le tracce.
- Riassunti LLM (Fase E).
- Mixdown stereo mic+sistema: file separati per traccia.

## Architettura

- `stenon-core/src/audio/loopback.rs` — wrapper SCK: `LoopbackCapture::start()`
  restituisce handle con buffer accumulato; `stop()` → (pcm f32, rate, channels).
  Callback su thread SCK, buffer `Arc<Mutex<Vec<f32>>>` (schema identico a `Capture`).
- `stenon-core/src/audio/wav.rs` — scrittura WAV PCM16 mono 16 kHz, zero dipendenze.
- Worker (`spawn_recorder`): nuovi comandi `MeetingStart` / `MeetingStop`.
  Durante la riunione ogni traccia accumula; ogni ~8 s di audio nuovo → trascrizione
  del chunk → evento `meeting-chunk` {note_id, track, text, start_ms, end_ms}.
- DB: `save_meeting()` in pipeline (note mode='riunione', 2 tracce, segmenti per
  track_id, version raw); `get_note` restituisce anche i segmenti per traccia
  (`NoteDetail.tracks: Vec<TrackSegs>`), retrocompatibile.
- Tauri: comandi `start_meeting` / `stop_meeting`; eventi `meeting-chunk`,
  `meeting-permission`.
- Frontend: bottone "Nuova riunione" → start; utterances live append per traccia;
  stop → nota completa e selezionata.

## Verifica

- `cargo check` + test pipeline (save_meeting con DB in memoria).
- Test runtime: permesso Screen Recording concesso, riunione con audio YouTube
  in background + voce: utterances per traccia, audio WAV riproducibile, nota
  ricaricata dopo riavvio.
