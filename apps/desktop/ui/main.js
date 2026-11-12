/**
 * Stenon v2 — main.js
 * Prototipo completo Tauri-ready:
 *   - Dettatura multilingua + Note editabili a passate
 *   - Fonti audio multiple (selezione multipla, isolamento per canale)
 *   - Modalità Riunione stile Chat (Voce 1, Voce 2…, sovrapposizioni multi-fonte e mono-fonte, pausa/stop, memoria audio dedicata)
 *   - 6 Modalità di Riassunto/Strutturazione (Solo formattazione, Fedele, Schematico, Verbale POH, Brainstorming Diátaxis/Atomico, Nota lavoro Question-First) + YAML Frontmatter RAG
 */

/* ==========================================================================
   01. ADATTATORE COMANDI TAURI (v1 & v2)
   ========================================================================== */
const TAURI_COMMANDS = {
  // Dettatura
  START_RECORDING: "start_recording",
  STOP_RECORDING: "stop_recording",
  CANCEL_RECORDING: "cancel_recording",
  REINSERT_TEXT: "reinsert_text",

  // Modalità Riunione & Fonti Audio
  LIST_AUDIO_SOURCES: "list_audio_sources",
  SET_AUDIO_SOURCES: "set_active_audio_sources",
  START_MEETING: "start_meeting_recording",
  PAUSE_MEETING: "pause_meeting_recording",
  RESUME_MEETING: "resume_meeting_recording",
  STOP_MEETING: "stop_meeting_recording",

  // Note, Riassunti AI & Impostazioni
  SAVE_NOTE: "save_note",
  DELETE_NOTE: "delete_note",
  GENERATE_SUMMARY: "generate_structured_summary",
  SAVE_VOCABULARY: "save_vocabulary",
  SAVE_SETTINGS: "save_settings",
  UPDATE_NOTE_TEXT: "update_note_text",
  SET_LANGUAGES: "set_languages",
};

const tauriInvoke =
  window.__TAURI__?.core?.invoke ||
  window.__TAURI__?.invoke ||
  null;

const tauriListen =
  window.__TAURI__?.event?.listen ||
  null;

async function callBackend(cmd, payload = {}) {
  if (tauriInvoke) {
    try {
      return await tauriInvoke(cmd, payload);
    } catch (err) {
      console.warn(`[Tauri invoke "${cmd}"]`, err);
      showToast(`Errore backend (${cmd}): ${err}`);
    }
  }
  return null;
}

/* ==========================================================================
   01b. ADATTATORE DATI REALI — Fase A (Tauri ↔ DB SQLite)
   In Tauri i dati vengono dal database; il fallback demo resta solo per
   l'apertura del file in un browser senza backend.
   ========================================================================== */
const REAL_BACKEND = !!tauriInvoke;

function fmtHHMM(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dateGroupFor(d) {
  const dayKey = (x) =>
    Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86400000);
  const diff = dayKey(new Date()) - dayKey(d);
  if (diff === 0) return "Oggi";
  if (diff === 1) return "Ieri";
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "long" });
}

function mapSummaryToCard(s) {
  const d = new Date(s.created_at); // ms dall'epoch
  return {
    id: s.id,
    kind: "dictation",
    project: "",
    customTitle: false,
    title: "",
    createdAt: d.toISOString(),
    dateIso: d.toISOString().slice(0, 10),
    dateGroup: dateGroupFor(d),
    dateShort:
      d.toLocaleDateString("it-IT", { day: "numeric", month: "short" }) + ", " + fmtHHMM(d),
    dateFull:
      d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }) +
      ", " +
      fmtHHMM(d),
    durationSec: Math.round((s.duration_ms || 0) / 1000),
    lang: (s.language || "auto").toUpperCase(),
    modelUsed: "whisper base",
    sourceApp: "",
    pinned: false,
    passes: [], // riempite da hydrateNote (get_note)
  };
}

function mapDetailToNote(d) {
  return {
    passes: (d.segments || []).map((sg, i) => {
      const start = new Date(d.created_at + sg.start_ms);
      return {
        id: "s" + i,
        time: fmtHHMM(start),
        durationSec: Math.max(0, Math.round((sg.end_ms - sg.start_ms) / 1000)),
        lang: (d.language || "auto").toUpperCase(),
        text: sg.text,
      };
    }),
  };
}

async function hydrateNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n || n._hydrated || !tauriInvoke) return;
  try {
    const d = await tauriInvoke("get_note", { id });
    if (d) {
      Object.assign(n, mapDetailToNote(d));
      n._hydrated = true;
    }
  } catch (err) {
    console.warn("[stenon] get_note fallito:", err);
    showToast("Errore caricamento nota: " + err);
  }
}

async function loadRealNotes() {
  try {
    const summaries = await tauriInvoke("list_notes");
    state.notes = (summaries || []).map(mapSummaryToCard);
    if (state.notes.length) {
      state.selectedNoteId = state.notes[0].id;
      await hydrateNote(state.selectedNoteId);
    } else {
      state.selectedNoteId = null;
    }
  } catch (err) {
    console.error("[stenon] list_notes fallito:", err);
    showToast("Errore caricamento note: " + err);
  }
}

// Salvataggio debounced del testo modificato (Fase A: solo testo, via update_note_text)
let _noteTextSaveTimer = null;
function saveNoteTextBackend(note) {
  if (!REAL_BACKEND || !note || note.kind !== "dictation") return;
  clearTimeout(_noteTextSaveTimer);
  _noteTextSaveTimer = setTimeout(() => {
    const text = (note.passes || [])
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n");
    callBackend(TAURI_COMMANDS.UPDATE_NOTE_TEXT, { id: note.id, text });
  }, 400);
}

/* ==========================================================================
   02. STATO APPLICAZIONE & DATI REALISTICI
   ========================================================================== */
const state = {
  captureMode: "dictation", // "dictation" | "meeting"
  appStatus: "idle",        // "idle" | "recording" | "paused" | "transcribing"
  recordingSeconds: 0,
  recordingTarget: "new",
  dictationLang: "AUTO",

  // Filtri
  searchQuery: "",
  scope: "all", // "all" | "meetings" | "pinned"
  selectedLangFilters: new Set(),

  // Nota attiva e vista riassunto attiva
  selectedNoteId: "mtg-q1",
  activeViewMode: "original", // "original" | "format_only" | "lossless" | "schematic" | "meeting_poh" | "brainstorming" | "work_note"
  includeYamlFrontmatter: true,

  // Player audio riunione simulato/collegabile
  audioPlaying: false,
  audioCurrentSec: 0,
  audioSpeedIndex: 0, // [1, 1.25, 1.5, 2]
  selectedAudioTrack: "mix",

  // Eliminazione inline + Undo
  pendingDeleteCardId: null,
  detailDeleteConfirmOpen: false,
  lastDeleted: null,

  // Preferenze vista
  editorFont: "sans",
  sidebarCollapsed: false,

  // Fonti audio disponibili sul sistema (selezione multipla / disattivazione)
  audioSources: [
    {
      id: "src-mic-builtin",
      name: "🎙 Microfono MacBook Pro (Integrato)",
      kind: "mic",
      channelTag: "CH1 · Mic Locale",
      description: "Cattura la tua voce su traccia isolata dedicata (48 kHz).",
      enabled: true,
    },
    {
      id: "src-sys-loopback",
      name: "🖥 Audio di Sistema (ScreenCaptureKit / Loopback)",
      kind: "system",
      channelTag: "CH2 · Sistema",
      description: "Cattura i partecipanti remoti (Zoom, Meet, Teams, Browser) su traccia separata.",
      enabled: true,
    },
    {
      id: "src-usb-headset",
      name: "🎧 AirPods Pro / Cuffie USB Esterno",
      kind: "mic",
      channelTag: "CH3 · Headset",
      description: "Microfono secondario o cuffie Bluetooth/USB.",
      enabled: false,
    },
    {
      id: "src-room-mic",
      name: "🎛 Microfono Sala Riunioni (Omnidirezionale)",
      kind: "mic",
      channelTag: "CH4 · Sala",
      description: "Più voci fisiche sullo stesso canale → usa diarizzazione locale.",
      enabled: false,
    },
  ],

  settings: {
    model: "small",
    engine: "GPU (Metal)",
    diarizationModel: "pyannote_overlap",
    llmProvider: "ollama",
    defaultProject: "pianificazione-q1",
    audioRetention: "forever",
    activeLanguages: ["IT", "EN", "JA"],
    hotkey: "⌥ Space",
    pasteMode: "clipboard",
    theme: "system",
  },

  vocabulary: [
    { id: "v1", term: "Tauri", category: "Tecnici" },
    { id: "v2", term: "Whisper.cpp", category: "Tecnici" },
    { id: "v3", term: "ScreenCaptureKit", category: "Tecnici" },
    { id: "v4", term: "MossFormer2", category: "Tecnici" },
    { id: "v5", term: "Pyannote", category: "Tecnici" },
    { id: "v6", term: "Giulia Ferretti", category: "Nomi" },
    { id: "v7", term: "POH", category: "Acronimi" },
    { id: "v8", term: "RAG", category: "Acronimi" },
  ],

  notes: [
    // 1. RIUNIONE MULTICANALE CON VOCI SOVRAPPOSTE (Fonti diverse + Stessa fonte)
    {
      id: "mtg-q1",
      kind: "meeting",
      project: "pianificazione-q1",
      customTitle: true,
      title: "Pianificazione Q1: lancio beta, preventivo e fornitori",
      createdAt: "2026-11-11T15:00:00",
      dateIso: "2026-11-11",
      dateGroup: "Oggi",
      dateShort: "11 nov, 15:00",
      dateFull: "11 nov 2026, 15:00",
      durationSec: 252,
      lang: "IT",
      modelUsed: "small · Metal + Pyannote",
      sourceApp: "👥 2 fonti isolate",
      pinned: true,
      audioVault: {
        folder: "/meeting_audio/2026-11-11_mtg-q1/",
        sizeMb: "18.4 MB",
        tracks: [
          { id: "mix", label: "🔊 Mix completo (Tutte le fonti)" },
          { id: "src-mic-builtin", label: "🎙 Solo CH1: Microfono Integrato" },
          { id: "src-sys-loopback", label: "🖥 Solo CH2: Audio di Sistema" },
        ],
      },
      speakers: [
        { id: "spk-1", label: "Voce 1", sourceId: "src-mic-builtin", sourceBadge: "CH1 · Mic Locale" },
        { id: "spk-2", label: "Voce 2", sourceId: "src-sys-loopback", sourceBadge: "CH2 · Sistema (Diarizz.)" },
        { id: "spk-3", label: "Voce 3", sourceId: "src-sys-loopback", sourceBadge: "CH2 · Sistema (Diarizz.)" },
      ],
      utterances: [
        {
          id: "u1",
          speakerId: "spk-1",
          startSec: 8,
          timeLabel: "00:08",
          lang: "IT",
          overlapType: null,
          text: "Allora facciamo il punto rapido per il lancio del primo trimestre: dobbiamo fissare la data definitiva e chiudere i preventivi con il fornitore hardware.",
        },
        {
          id: "u2",
          speakerId: "spk-2",
          startSec: 34,
          timeLabel: "00:34",
          lang: "IT",
          overlapType: null,
          text: "Per me il lancio il 15 gennaio è confermato e vincolante. Io invio il preventivo aggiornato entro il 18 novembre così blocchiamo il budget.",
        },
        {
          id: "u3",
          speakerId: "spk-1",
          startSec: 78,
          timeLabel: "01:18",
          lang: "IT",
          overlapType: "isolated_sources", // Sovrapposizione tra CH1 e CH2 -> zero confusione!
          text: "Perfetto, io intanto chiamo il fornitore entro il 20 novembre per verificare i tempi di consegna—",
        },
        {
          id: "u4",
          speakerId: "spk-2",
          startSec: 80,
          timeLabel: "01:20",
          lang: "IT",
          overlapType: "isolated_sources",
          text: "—sì esatto, fagli presente che il budget resta confermato solo se il preventivo totale rimane sotto i dodicimila euro.",
        },
        {
          id: "u5",
          speakerId: "spk-3",
          startSec: 164,
          timeLabel: "02:44",
          lang: "IT",
          overlapType: "same_source_local", // Sovrapposizione tra Voce 2 e Voce 3 entrambi su CH2!
          text: "Aggiungo una proposta: potremmo testare anche un modulo offline su iPad se il costo licenza resta sotto mille euro.",
        },
        {
          id: "u6",
          speakerId: "spk-2",
          startSec: 166,
          timeLabel: "02:46",
          lang: "IT",
          overlapType: "same_source_local",
          text: "Vale la pena testare la versione mobile già a gennaio o rischiamo di rallentare il desktop? Scartiamo invece il porting Linux legacy per mancanza di driver audio.",
        },
      ],
      passes: [],
      summaries: {},
    },

    // 2. NOTA DI DETTATURA MULTIPASSATA (Lavoro tecnico)
    {
      id: "note-1",
      kind: "dictation",
      project: "stenon-tauri",
      customTitle: false,
      title: "",
      createdAt: "2026-11-11T14:32:00",
      dateIso: "2026-11-11",
      dateGroup: "Oggi",
      dateShort: "11 nov, 14:32",
      dateFull: "11 nov 2026, 14:32",
      durationSec: 38,
      lang: "IT",
      modelUsed: "small · Metal",
      sourceApp: "↗ VS Code",
      pinned: true,
      passes: [
        {
          id: "p1",
          time: "14:32",
          durationSec: 23,
          lang: "IT",
          text: "Configurazione pipeline audio multicanale in Tauri: usare ScreenCaptureKit su macOS per isolare l'audio di sistema dal microfono fisico ed evitare qualsiasi sovrapposizione tra l'utente locale e gli interlocutori remoti.",
        },
        {
          id: "p2",
          time: "14:36",
          durationSec: 15,
          lang: "IT",
          text: "Resta urgente verificare i permessi di registrazione schermo al primo avvio e chiarire se comprimere l'archivio riunioni in formato Opus a 32 kbps.",
        },
      ],
      summaries: {},
    },

    // 3. NOTA BRAINSTORMING / IDEE PRODOTTO (EN)
    {
      id: "note-2",
      kind: "dictation",
      project: "roadmap-ai",
      customTitle: false,
      title: "",
      createdAt: "2026-11-11T11:18:00",
      dateIso: "2026-11-11",
      dateGroup: "Oggi",
      dateShort: "11 nov, 11:18",
      dateFull: "11 nov 2026, 11:18",
      durationSec: 24,
      lang: "EN",
      modelUsed: "small · Metal",
      sourceApp: "↗ Slack",
      pinned: false,
      passes: [
        {
          id: "p1",
          time: "11:18",
          durationSec: 24,
          lang: "EN",
          text: "Brainstorming ideas for Q1 voice notes: add automatic YAML frontmatter so Obsidian and local RAG pipelines can query every meeting decision immediately. Maybe test speaker voiceprint matching across meetings? Drop cloud-only sync for now because users want strict local privacy.",
        },
      ],
      summaries: {},
    },

    // 4. NOTA GIAPPONESE (JA)
    {
      id: "note-3",
      kind: "dictation",
      project: "tokyo-sync",
      customTitle: false,
      title: "",
      createdAt: "2026-11-10T09:45:00",
      dateIso: "2026-11-10",
      dateGroup: "Ieri",
      dateShort: "10 nov, 09:45",
      dateFull: "10 nov 2026, 09:45",
      durationSec: 14,
      lang: "JA",
      modelUsed: "medium · Metal",
      sourceApp: "📝 App",
      pinned: false,
      passes: [
        {
          id: "p1",
          time: "09:45",
          durationSec: 14,
          lang: "JA",
          text: "来週の火曜日に東京チームとのデザインレビューを設定してください。複数オーディオソースの分離デモを共有します。",
        },
      ],
      summaries: {},
    },
  ],
};

const AUDIO_SPEEDS = [1, 1.25, 1.5, 2];
let recordingInterval = null;
let transcribeTimeout = null;
let audioPlayInterval = null;
let autosaveTimeout = null;
let toastTimeout = null;
let isRecordingHotkey = false;

/* ==========================================================================
   03. UTILITY DI TESTO, STATISTICHE E GENERATORI STRUTTURATI (POH/WIKI/RAG)
   ========================================================================== */
function getNotePlainTranscript(note) {
  if (note.kind === "meeting") {
    return (note.utterances || [])
      .map((u) => {
        const spk = note.speakers.find((s) => s.id === u.speakerId)?.label || "Voce";
        return `[${u.timeLabel}] ${spk}: ${u.text.trim()}`;
      })
      .join("\n");
  }
  return (note.passes || []).map((p) => p.text.trim()).filter(Boolean).join("\n\n");
}

function getNoteRawBodyOnly(note) {
  if (note.kind === "meeting") {
    return (note.utterances || []).map((u) => u.text.trim()).join(" ");
  }
  return (note.passes || []).map((p) => p.text.trim()).filter(Boolean).join("\n\n");
}

function computeAutoTitle(text, lang = "IT") {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Nota vuota";
  if (lang === "JA" || /[\u3040-\u30ff\u4e00-\u9faf]/.test(clean)) {
    return clean.length > 18 ? clean.slice(0, 18) + "…" : clean;
  }
  const words = clean.split(" ");
  const slice = words.slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
  return words.length > 6 ? `${slice}…` : slice;
}

function getEffectiveTitle(note) {
  if (note.customTitle && note.title.trim()) return note.title.trim();
  return computeAutoTitle(getNoteRawBodyOnly(note), note.lang);
}

function computeTextStats(text, lang = "IT") {
  const trimmed = (text || "").trim();
  const chars = trimmed.length;
  if (!chars) return { chars: 0, words: 0 };

  if ((lang === "JA" || /[\u3040-\u30ff\u4e00-\u9faf]/.test(trimmed)) && typeof Intl !== "undefined" && Intl.Segmenter) {
    const seg = new Intl.Segmenter("ja", { granularity: "word" });
    let words = 0;
    for (const part of seg.segment(trimmed)) {
      if (part.isWordLike) words++;
    }
    return { chars, words: Math.max(1, words) };
  }
  return { chars, words: trimmed.split(/\s+/).filter(Boolean).length };
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightQuery(text, query) {
  const safe = escapeHtml(text);
  if (!query.trim()) return safe;
  const escapedQ = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${escapedQ})`, "gi"), "<mark>$1</mark>");
}

function normalizeVocabCandidate(raw) {
  return (raw || "")
    .trim()
    .replace(/^[\s"'“”‘’.,;:!?()[\]{}<>]+|[\s"'“”‘’.,;:!?()[\]{}<>]+$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Costruisce il blocco YAML Frontmatter per interrogazione IA / RAG.
 */
function buildYamlFrontmatter(note, tipo, extraFields = {}) {
  if (!state.includeYamlFrontmatter) return "";
  const lines = [
    "---",
    `data: ${note.dateIso || "2026-11-11"}`,
    `progetto: ${note.project || state.settings.defaultProject || "generale"}`,
    `tipo: ${tipo}`,
    `stato: attivo`, `tags: ${JSON.stringify(tagsOf(note))}`,
  ];
  if (note.kind === "meeting" && note.speakers?.length) {
    lines.push(`partecipanti: [${note.speakers.map((s) => s.label).join(", ")}]`);
  }
  for (const [k, v] of Object.entries(extraFields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("---\n\n");
  return lines.join("\n");
}

/**
 * Genera in locale (fallback/prototipo) i 6 formati strutturati richiesti.
 * Quando connesso a Tauri, chiama `TAURI_COMMANDS.GENERATE_SUMMARY`.
 */
function buildStructuredTransform(note, mode) {
  const title = getEffectiveTitle(note);
  const spk1 = note.speakers?.[0]?.label || "Voce 1";
  const spk2 = note.speakers?.[1]?.label || "Voce 2";
  const spk3 = note.speakers?.[2]?.label || "Voce 3";

  // Caso specifico ricco per la riunione demo Q1
  if (note.id === "mtg-q1") {
    if (mode === "format_only") {
      return (
        buildYamlFrontmatter(note, "trascrizione-formattata") +
        `**${spk1}:** Facciamo il punto rapido per il lancio del primo trimestre. Dobbiamo fissare la data definitiva e chiudere i preventivi con il fornitore hardware.\n\n` +
        `**${spk2}:** Il lancio del 15 gennaio è confermato e vincolante. Invierò il preventivo aggiornato entro il 18 novembre per bloccare il budget.\n\n` +
        `**${spk1}:** Chiamerò il fornitore entro il 20 novembre per verificare i tempi di consegna.\n\n` +
        `**${spk2}:** Il budget per il Q1 resta confermato solo se il preventivo totale rimane sotto i 12.000 euro.\n\n` +
        `**${spk3}:** Propongo di testare un modulo offline su iPad se il costo della licenza resta sotto 1.000 euro.\n\n` +
        `**${spk2}:** Dobbiamo valutare se testare la versione mobile a gennaio rischi di rallentare il rilascio desktop. Scartiamo invece il porting Linux legacy per assenza di driver audio stabili.`
      );
    }

    if (mode === "lossless") {
      return (
        buildYamlFrontmatter(note, "riassunto-integrale", { argomento: title }) +
        `Il lancio del primo trimestre è fissato in modo vincolante per il 15 gennaio. ` +
        `${spk2} invierà il preventivo aggiornato entro il 18 novembre per bloccare il budget disponibile. ` +
        `${spk1} contatterà il fornitore hardware entro il 20 novembre per verificare i tempi effettivi di consegna. ` +
        `Il budget complessivo del Q1 è confermato esclusivamente a condizione che il preventivo totale resti inferiore a 12.000 euro. ` +
        `${spk3} ha proposto di sperimentare un modulo offline su iPad qualora il costo di licenza sia inferiore a 1.000 euro; resta aperto il dubbio se avviare il test mobile a gennaio possa rallentare la versione desktop. ` +
        `Il porting per sistemi Linux legacy è stato scartato a causa della mancanza di driver audio adeguati.`
      );
    }

    if (mode === "schematic") {
      return (
        buildYamlFrontmatter(note, "riassunto-schematico", { argomento: title }) +
        `## Punti chiave autoconclusivi\n` +
        `- **Data di lancio Q1:** Il rilascio ufficiale è fissato per il 15 gennaio.\n` +
        `- **Vincolo economico:** Il budget Q1 è approvato solo con preventivo totale inferiore a 12.000 €.\n` +
        `- **Scadenza preventivo (${spk2}):** Invio del preventivo aggiornato fissato entro il 18/11.\n` +
        `- **Verifica fornitore (${spk1}):** Chiamata al fornitore hardware fissata entro il 20/11.\n` +
        `- **Opzione iPad (${spk3}):** Valutabile solo se la licenza costa meno di 1.000 €; escluso il supporto Linux legacy.`
      );
    }

    if (mode === "meeting_poh") {
      return (
        buildYamlFrontmatter(note, "verbale", { argomento: "pianificazione Q1" }) +
        `## Decisioni (vincolanti)\n` +
        `1. Lancio fissato al 15 gennaio, deciso.\n` +
        `2. Escludere il porting Linux legacy per assenza di driver audio.\n\n` +
        `## Azioni (checklist POH)\n` +
        `- [ ] ${spk2}: inviare preventivo aggiornato — entro 18/11\n` +
        `- [ ] ${spk1}: chiamare fornitore hardware per tempi consegna — entro 20/11\n` +
        `- [ ] ${spk3}: verificare costo licenza modulo offline iPad (< 1.000 €) — entro 22/11\n\n` +
        `## Note (contesto e condizioni)\n` +
        `- Il budget Q1 resta confermato solo se il preventivo totale rimane sotto 12.000 €.\n` +
        `- Avviare il test mobile a gennaio non deve rallentare la milestone desktop del 15 gennaio.`
      );
    }

    if (mode === "brainstorming") {
      return (
        buildYamlFrontmatter(note, "brainstorming", { argomento: title }) +
        `## Fase 1 — Dump grezzo\n` +
        `- Lancio Q1 il 15 gennaio\n` +
        `- Preventivo fornitore hardware entro 18/11 sotto soglia 12.000 €\n` +
        `- Modulo offline su iPad\n` +
        `- Porting Linux legacy\n\n` +
        `## Fase 2 — Riorganizzazione Diátaxis\n` +
        `### Idee attuabili\n` +
        `- Prototipare il modulo offline su iPad — fattibile se il costo licenza resta < 1.000 €.\n` +
        `- Bloccare l'ordine col fornitore hardware — attuabile se il preventivo entro il 18/11 resta < 12.000 €.\n\n` +
        `### Idee da approfondire\n` +
        `- Vale la pena testare il modulo iPad già a gennaio senza rallentare il rilascio desktop del 15 gennaio?\n\n` +
        `### Scartate\n` +
        `- Porting su distribuzioni Linux legacy — scartata per assenza di driver audio multicanale affidabili.\n\n` +
        `## Fase 3 — Idee atomiche (autoconclusive per RAG)\n` +
        `- **Modulo iPad Offline:** L'estensione offline su iPad può essere avviata nel Q1 solo se il costo delle licenze rimane inferiore a 1.000 € e non impatta il lancio desktop del 15 gennaio.`
      );
    }

    if (mode === "work_note") {
      return (
        buildYamlFrontmatter(note, "nota-lavoro") +
        `## Come garantire il lancio Q1 entro il 15 gennaio?\n` +
        `**Conclusione:** Il lancio del 15 gennaio è confermato a patto di chiudere il preventivo sotto i 12.000 € entro il 18/11 e verificare le consegne col fornitore entro il 20/11.\n\n` +
        `- (!) ${spk2} invia il preventivo definitivo entro il 18/11 mantenendo il totale sotto 12.000 €.\n` +
        `- (!) ${spk1} conferma i tempi di spedizione col fornitore hardware entro il 20/11.\n` +
        `- (?) Il test del modulo iPad (< 1.000 €) impatta la capacità del team prima del 15 gennaio?\n` +
        `- (✓) Il porting Linux legacy è escluso definitivamente dallo scope Q1.`
      );
    }
  }

  // Generatore adattivo per qualsiasi altra nota dettata o creata dall'utente
  const raw = getNotePlainTranscript(note).trim() || "Nessun contenuto disponibile.";
  const sentences = raw
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (mode === "format_only") {
    return buildYamlFrontmatter(note, "formattazione") + sentences.join("\n\n");
  }
  if (mode === "lossless") {
    return (
      buildYamlFrontmatter(note, "riassunto-fedele", { argomento: title }) +
      sentences.map((s) => (/[.!?。]$/.test(s) ? s : s + ".")).join(" ")
    );
  }
  if (mode === "schematic") {
    return (
      buildYamlFrontmatter(note, "schematico", { argomento: title }) +
      `## Sintesi schematica\n` +
      sentences.map((s) => `- ${s}`).join("\n")
    );
  }
  if (mode === "meeting_poh") {
    return (
      buildYamlFrontmatter(note, "verbale", { argomento: title }) +
      `## Decisioni (vincolanti)\n` +
      `1. ${sentences[0] || title}\n\n` +
      `## Azioni (checklist POH)\n` +
      `- [ ] Responsabile: eseguire verifica operativa su "${title}" — entro 18/11\n\n` +
      `## Note (contesto)\n` +
      sentences.slice(1).map((s) => `- ${s}`).join("\n") || `- Nessun vincolo aggiuntivo registrato.`
    );
  }
  if (mode === "brainstorming") {
    return (
      buildYamlFrontmatter(note, "brainstorming", { argomento: title }) +
      `## Fase 1 — Dump grezzo\n` +
      sentences.map((s) => `- ${s}`).join("\n") +
      `\n\n## Fase 2 — Riorganizzazione Diátaxis\n` +
      `### Idee attuabili\n- Implementare "${title}" — fattibile se validato nei test locali.\n\n` +
      `### Idee da approfondire\n- Qual è l'impatto sulle prestazioni e sullo spazio disco?\n\n` +
      `### Scartate\n- Soluzioni solo cloud — scartate per mantenere la privacy locale.\n\n` +
      `## Fase 3 — Idee atomiche\n- **${title}:** ${sentences[0] || raw}`
    );
  }
  // work_note (Minimalism + Question-First)
  return (
    buildYamlFrontmatter(note, "nota-lavoro") +
    `## Come gestire: ${title}?\n` +
    `**Conclusione:** ${sentences[0] || raw}\n\n` +
    sentences.map((s, i) => `- ${i === 0 ? "(✓)" : i === 1 ? "(!)" : "(?)"} ${s}`).join("\n")
  );
}

const SUMMARY_METHOD_DESCRIPTIONS = {
  format_only: "✨ Solo formattazione — Punteggiatura e paragrafi ripuliti senza tagliare o alterare alcuna informazione.",
  lossless: "🔍 Riassunto senza perdita di informazioni — Tutte le cifre, scadenze, condizioni e decisioni espresse in frasi autoconclusive.",
  schematic: "📋 Riassunto schematico — Punti chiave sintetici e autoconclusivi pronti per una lettura rapida.",
  meeting_poh: "📅 Verbale di riunione (Modello POH + YAML) — Separa Decisioni vincolanti, Azioni imperative con scadenza e Note di contesto.",
  brainstorming: "🧠 Brainstorming (Wiki / Diátaxis / Atomicità) — 1. Dump grezzo → 2. Attuabili / Da approfondire / Scartate col motivo → 3. Idee atomiche.",
  work_note: "📓 Nota di lavoro (Minimalism + Question-First) — Titolo come domanda/tema, conclusione in testa (Inverted Pyramid) e priorità (!)/(?)/(✓).",
};

/* ==========================================================================
   04. RIFERIMENTI DOM
   ========================================================================== */
const el = {
  appShell: document.getElementById("appShell"),
  btnCycleTheme: document.getElementById("btnCycleTheme"),
  btnToggleSidebar: document.getElementById("btnToggleSidebar"),
  btnExpandSidebar: document.getElementById("btnExpandSidebar"),

  // Selettore modalità
  btnModeDictation: document.getElementById("btnModeDictation"),
  btnModeMeeting: document.getElementById("btnModeMeeting"),
  dictationCapturePanel: document.getElementById("dictationCapturePanel"),
  meetingCapturePanel: document.getElementById("meetingCapturePanel"),

  // Stato Dettatura
  statusTitle: document.getElementById("statusTitle"),
  statusTimer: document.getElementById("statusTimer"),
  statusSubtitle: document.getElementById("statusSubtitle"),
  micMeter: document.getElementById("micMeter"),
  statusRecordingActions: document.getElementById("statusRecordingActions"),
  btnStopRecording: document.getElementById("btnStopRecording"),
  btnCancelRecording: document.getElementById("btnCancelRecording"),
  dictationLangPills: document.getElementById("dictationLangPills"),
  btnNewVoiceNote: document.getElementById("btnNewVoiceNote"),
  btnNewEmptyNote: document.getElementById("btnNewEmptyNote"),

  // Stato Riunione
  meetingStatusTitle: document.getElementById("meetingStatusTitle"),
  meetingTimer: document.getElementById("meetingTimer"),
  meetingStatusSub: document.getElementById("meetingStatusSub"),
  btnQuickAudioSources: document.getElementById("btnQuickAudioSources"),
  activeSourcesSummaryText: document.getElementById("activeSourcesSummaryText"),
  meetingLiveChannels: document.getElementById("meetingLiveChannels"),
  btnStartMeeting: document.getElementById("btnStartMeeting"),
  meetingActiveControls: document.getElementById("meetingActiveControls"),
  btnPauseResumeMeeting: document.getElementById("btnPauseResumeMeeting"),
  pauseResumeIcon: document.getElementById("pauseResumeIcon"),
  pauseResumeLabel: document.getElementById("pauseResumeLabel"),
  btnStopMeeting: document.getElementById("btnStopMeeting"),

  // Ricerca e filtri
  searchInput: document.getElementById("searchInput"),
  searchKbd: document.getElementById("searchKbd"),
  btnClearSearch: document.getElementById("btnClearSearch"),
  tabScopeAll: document.getElementById("tabScopeAll"),
  tabScopeMeetings: document.getElementById("tabScopeMeetings"),
  tabScopePinned: document.getElementById("tabScopePinned"),
  countAll: document.getElementById("countAll"),
  countMeetings: document.getElementById("countMeetings"),
  countPinned: document.getElementById("countPinned"),
  langFilterChips: document.getElementById("langFilterChips"),
  btnResetLangFilter: document.getElementById("btnResetLangFilter"),
  vocabCountBadge: document.getElementById("vocabCountBadge"),
  audioVaultBadge: document.getElementById("audioVaultBadge"),
  footerHotkeyBadge: document.getElementById("footerHotkeyBadge"),
  btnOpenAudioVault: document.getElementById("btnOpenAudioVault"),

  // Lista note
  notesHeaderTitle: document.getElementById("notesHeaderTitle"),
  activeFilterSummary: document.getElementById("activeFilterSummary"),
  notesList: document.getElementById("notesList"),
  notesEmpty: document.getElementById("notesEmpty"),
  btnClearAllFilters: document.getElementById("btnClearAllFilters"),

  // Dettaglio
  detailPlaceholder: document.getElementById("detailPlaceholder"),
  placeholderHotkey: document.getElementById("placeholderHotkey"),
  detailContentWrap: document.getElementById("detailContentWrap"),
  detailKindPill: document.getElementById("detailKindPill"),
  detailSourcePill: document.getElementById("detailSourcePill"),
  detailModelPill: document.getElementById("detailModelPill"),
  detailProjectInput: document.getElementById("detailProjectInput"),
  autosaveIndicator: document.getElementById("autosaveIndicator"),
  autosaveText: document.getElementById("autosaveText"),
  btnTogglePinDetail: document.getElementById("btnTogglePinDetail"),
  detailTitleInput: document.getElementById("detailTitleInput"),
  btnResetAutoTitle: document.getElementById("btnResetAutoTitle"),
  metaDate: document.getElementById("metaDate"),
  metaDuration: document.getElementById("metaDuration"),
  metaLang: document.getElementById("metaLang"),
  metaStats: document.getElementById("metaStats"),

  // Inspector Riunione (Audio player + Voci)
  meetingInspectorBand: document.getElementById("meetingInspectorBand"),
  btnAudioPlayPause: document.getElementById("btnAudioPlayPause"),
  audioPlayIcon: document.getElementById("audioPlayIcon"),
  audioTimeCurrent: document.getElementById("audioTimeCurrent"),
  audioVaultPath: document.getElementById("audioVaultPath"),
  audioTimeTotal: document.getElementById("audioTimeTotal"),
  audioScrubber: document.getElementById("audioScrubber"),
  audioTrackSelect: document.getElementById("audioTrackSelect"),
  btnAudioSpeed: document.getElementById("btnAudioSpeed"),
  speakersStrip: document.getElementById("speakersStrip"),

  // Barra riassunti
  summaryModePills: document.getElementById("summaryModePills"),
  chkIncludeYaml: document.getElementById("chkIncludeYaml"),
  btnRegenerateSummary: document.getElementById("btnRegenerateSummary"),

  // Editor e Viste
  editorScrollArea: document.getElementById("editorScrollArea"),
  passesEditor: document.getElementById("passesEditor"),
  meetingChatTimeline: document.getElementById("meetingChatTimeline"),
  structuredSummaryView: document.getElementById("structuredSummaryView"),
  summaryMethodBanner: document.getElementById("summaryMethodBanner"),
  summaryEditableSurface: document.getElementById("summaryEditableSurface"),
  editorHelperHint: document.getElementById("editorHelperHint"),

  // Popover selezione
  selectionPopover: document.getElementById("selectionPopover"),
  popoverTermPreview: document.getElementById("popoverTermPreview"),
  btnPopoverAddVocab: document.getElementById("btnPopoverAddVocab"),
  popoverVocabIcon: document.getElementById("popoverVocabIcon"),
  popoverVocabLabel: document.getElementById("popoverVocabLabel"),
  btnPopoverCopy: document.getElementById("btnPopoverCopy"),
  popoverCopyIcon: document.getElementById("popoverCopyIcon"),
  popoverCopyLabel: document.getElementById("popoverCopyLabel"),

  // Footer azioni
  btnAppendPass: document.getElementById("btnAppendPass"),
  btnExportMarkdown: document.getElementById("btnExportMarkdown"),
  btnCopyAll: document.getElementById("btnCopyAll"),
  copyAllLabel: document.getElementById("copyAllLabel"),
  btnReinsert: document.getElementById("btnReinsert"),
  btnDeleteDetail: document.getElementById("btnDeleteDetail"),
  detailConfirmGroup: document.getElementById("detailConfirmGroup"),
  btnConfirmDeleteDetail: document.getElementById("btnConfirmDeleteDetail"),
  btnCancelDeleteDetail: document.getElementById("btnCancelDeleteDetail"),

  // Modali
  btnOpenVocab: document.getElementById("btnOpenVocab"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  vocabModalBackdrop: document.getElementById("vocabModalBackdrop"),
  vocabAddForm: document.getElementById("vocabAddForm"),
  vocabNewInput: document.getElementById("vocabNewInput"),
  vocabCategorySelect: document.getElementById("vocabCategorySelect"),
  btnSubmitVocab: document.getElementById("btnSubmitVocab"),
  vocabSearchInput: document.getElementById("vocabSearchInput"),
  vocabStatsLabel: document.getElementById("vocabStatsLabel"),
  vocabTokenBar: document.getElementById("vocabTokenBar"),
  vocabGroupsContainer: document.getElementById("vocabGroupsContainer"),

  settingsModalBackdrop: document.getElementById("settingsModalBackdrop"),
  audioSourcesList: document.getElementById("audioSourcesList"),
  btnRefreshSources: document.getElementById("btnRefreshSources"),
  settingAudioRetention: document.getElementById("settingAudioRetention"),
  settingModel: document.getElementById("settingModel"),
  settingDiarization: document.getElementById("settingDiarization"),
  settingLlmProvider: document.getElementById("settingLlmProvider"),
  settingDefaultProject: document.getElementById("settingDefaultProject"),
  settingsLangCheckboxes: document.getElementById("settingsLangCheckboxes"),
  btnHotkeyRecorder: document.getElementById("btnHotkeyRecorder"),
  hotkeyDisplay: document.getElementById("hotkeyDisplay"),
  hotkeyHint: document.getElementById("hotkeyHint"),
  settingTheme: document.getElementById("settingTheme"),
  settingsSavedFeedback: document.getElementById("settingsSavedFeedback"),

  toastRegion: document.getElementById("toastRegion"),
};

/* ==========================================================================
   05. MODALITÀ CATTURA (DETTATURA VS RIUNIONE) E STATI REGISTRAZIONE
   ========================================================================== */
function setCaptureMode(mode) {
  state.captureMode = mode;
  el.appShell.dataset.captureMode = mode;
  el.btnModeDictation.classList.toggle("is-active", mode === "dictation");
  el.btnModeMeeting.classList.toggle("is-active", mode === "meeting");
  el.dictationCapturePanel.hidden = mode !== "dictation";
  el.meetingCapturePanel.hidden = mode !== "meeting";
  setAppStatus("idle");
}

function getEnabledAudioSources() {
  return state.audioSources.filter((s) => s.enabled);
}

function setAppStatus(nextStatus, options = {}) {
  clearInterval(recordingInterval);
  clearTimeout(transcribeTimeout);

  state.appStatus = nextStatus;
  el.appShell.dataset.appState = nextStatus;

  document.querySelectorAll("[data-demo-state]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.demoState === nextStatus);
  });

  const activeSrcs = getEnabledAudioSources();

  // Aggiorna UI Dettatura
  if (nextStatus === "idle") {
    el.statusTitle.textContent = "Pronto";
    el.statusTimer.hidden = true;
    el.micMeter.hidden = true;
    el.statusRecordingActions.hidden = true;
    el.statusSubtitle.innerHTML = `Premi <kbd>${escapeHtml(state.settings.hotkey)}</kbd> ovunque`;

    // UI Riunione idle
    el.meetingStatusTitle.textContent = "Pronto per riunione";
    el.meetingTimer.hidden = true;
    el.meetingStatusSub.textContent = "Salvataggio in memoria dedicata + chat voci";
    el.meetingLiveChannels.hidden = true;
    el.btnStartMeeting.hidden = false;
    el.meetingActiveControls.hidden = true;
  } else if (nextStatus === "recording") {
    state.recordingSeconds = options.initialSeconds ?? state.recordingSeconds ?? 0;
    state.recordingTarget = options.target || "new";

    // Dettatura
    el.statusTitle.textContent = "Registrazione…";
    el.statusTimer.hidden = false;
    el.statusTimer.textContent = formatDuration(state.recordingSeconds);
    el.micMeter.hidden = false;
    el.statusRecordingActions.hidden = false;
    el.statusSubtitle.textContent = `Ascolto su ${activeSrcs[0]?.channelTag || "Mic"}`;

    // Riunione
    el.meetingStatusTitle.textContent = "Riunione in corso…";
    el.meetingTimer.hidden = false;
    el.meetingTimer.textContent = formatDuration(state.recordingSeconds);
    el.meetingStatusSub.textContent = `${activeSrcs.length} canali registrati separatamente`;
    renderLiveMeetingChannels();
    el.meetingLiveChannels.hidden = false;
    el.btnStartMeeting.hidden = true;
    el.meetingActiveControls.hidden = false;
    el.pauseResumeIcon.textContent = "⏸";
    el.pauseResumeLabel.textContent = "Pausa";

    recordingInterval = setInterval(() => {
      state.recordingSeconds += 1;
      const formatted = formatDuration(state.recordingSeconds);
      el.statusTimer.textContent = formatted;
      el.meetingTimer.textContent = formatted;
    }, 1000);
  } else if (nextStatus === "paused") {
    el.meetingStatusTitle.textContent = "Riunione in pausa";
    el.meetingTimer.hidden = false;
    el.meetingStatusSub.textContent = "Audio sospeso · clicca Riprendi o Ferma";
    renderLiveMeetingChannels();
    el.meetingLiveChannels.hidden = false;
    el.btnStartMeeting.hidden = true;
    el.meetingActiveControls.hidden = false;
    el.pauseResumeIcon.textContent = "▶";
    el.pauseResumeLabel.textContent = "Riprendi";
  } else if (nextStatus === "transcribing") {
    const engineShort = state.settings.engine.includes("Metal") ? "Metal" : "CPU";
    el.statusTitle.textContent = "Trascrizione…";
    el.statusTimer.hidden = true;
    el.micMeter.hidden = true;
    el.statusRecordingActions.hidden = true;
    el.statusSubtitle.textContent = `Whisper ${state.settings.model} (${engineShort})…`;

    el.meetingStatusTitle.textContent = "Analisi voci e tracce…";
    el.meetingTimer.hidden = true;
    el.meetingLiveChannels.hidden = true;
    el.btnStartMeeting.hidden = true;
    el.meetingActiveControls.hidden = true;
    el.meetingStatusSub.textContent = "Separazione canali + diarizzazione locale…";
  }
}

function renderLiveMeetingChannels() {
  const activeSrcs = getEnabledAudioSources();
  el.meetingLiveChannels.innerHTML = activeSrcs
    .map(
      (s) => `
      <div class="live-ch-row">
        <span>${escapeHtml(s.channelTag)}</span>
        <div class="live-ch-bar"><div class="live-ch-fill"></div></div>
      </div>
    `
    )
    .join("");
}

/* --- Flussi Dettatura --- */
async function startDictationFlow(target = "new") {
  if (REAL_BACKEND) {
    // Fase A: la cattura è guidata dall'hotkey globale nel backend.
    showToast("Tieni premuto Ctrl+Shift+Spazio e parla; il bottone sarà collegato in Fase B");
    return;
  }
  state.recordingSeconds = 0;
  setAppStatus("recording", { target, initialSeconds: 0 });
  await callBackend(TAURI_COMMANDS.START_RECORDING, {
    lang: state.dictationLang,
    sources: getEnabledAudioSources().map((s) => s.id),
  });
}

async function stopAndTranscribeDictation() {
  const dur = Math.max(4, state.recordingSeconds || 6);
  const target = state.recordingTarget;
  setAppStatus("transcribing");
  await callBackend(TAURI_COMMANDS.STOP_RECORDING);

  if (!tauriInvoke) {
    transcribeTimeout = setTimeout(() => {
      const chosenLang =
        state.dictationLang !== "AUTO"
          ? state.dictationLang
          : state.settings.activeLanguages[0] || "IT";
      const hhmm = new Date().toTimeString().slice(0, 5);
      const text =
        chosenLang === "EN"
          ? "Confirmed that multi-source audio capture isolates system loopback from the built-in microphone cleanly."
          : "Nota vocale acquisita: il sistema salva automaticamente le modifiche e prepara il testo con frasi autoconclusive per la ricerca RAG.";

      if (target === "append" && state.selectedNoteId) {
        const note = state.notes.find((n) => n.id === state.selectedNoteId && n.kind === "dictation");
        if (note) {
          note.passes.push({ id: "p-" + Date.now(), time: hhmm, durationSec: dur, lang: chosenLang, text });
          note.durationSec += dur;
          note.summaries = {};
          setAppStatus("idle");
          renderAll();
          showToast("Nuova passata aggiunta");
          return;
        }
      }

      const newNote = {
        id: "note-" + Date.now(),
        kind: "dictation",
        project: state.settings.defaultProject,
        customTitle: false,
        title: "",
        createdAt: new Date().toISOString(),
        dateIso: "2026-11-11",
        dateGroup: "Oggi",
        dateShort: `Oggi, ${hhmm}`,
        dateFull: `11 nov 2026, ${hhmm}`,
        durationSec: dur,
        lang: chosenLang,
        modelUsed: `${state.settings.model} · Metal`,
        sourceApp: "📝 App",
        pinned: false,
        passes: [{ id: "p-" + Date.now(), time: hhmm, durationSec: dur, lang: chosenLang, text }],
        summaries: {},
      };
      state.notes.unshift(newNote);
      state.selectedNoteId = newNote.id;
      state.activeViewMode = "original";
      setAppStatus("idle");
      renderAll();
      showToast("Dettatura salvata");
    }, 900);
  }
}

/* --- Flussi Modalità Riunione (Registra / Pausa / Ferma) --- */
async function startMeetingFlow() {
  if (REAL_BACKEND) {
    // Fase C: cattura multicanale e pipeline riunione non ancora integrate.
    showToast("Modalità riunione: in arrivo (Fase C) — per ora è una demo");
    return;
  }
  if (getEnabledAudioSources().length === 0) {
    showToast("Attiva almeno una fonte audio nelle impostazioni");
    openSettingsTab("audio");
    return;
  }
  state.recordingSeconds = 0;
  setAppStatus("recording", { initialSeconds: 0 });
  await callBackend(TAURI_COMMANDS.START_MEETING, {
    sources: getEnabledAudioSources().map((s) => s.id),
  });
}

async function togglePauseMeetingFlow() {
  if (state.appStatus === "recording") {
    setAppStatus("paused");
    await callBackend(TAURI_COMMANDS.PAUSE_MEETING);
  } else if (state.appStatus === "paused") {
    setAppStatus("recording", { initialSeconds: state.recordingSeconds });
    await callBackend(TAURI_COMMANDS.RESUME_MEETING);
  }
}

async function stopMeetingFlow() {
  const dur = Math.max(18, state.recordingSeconds || 32);
  const activeSrcs = getEnabledAudioSources();
  setAppStatus("transcribing");
  await callBackend(TAURI_COMMANDS.STOP_MEETING);

  if (!tauriInvoke) {
    transcribeTimeout = setTimeout(() => {
      const hhmm = new Date().toTimeString().slice(0, 5);
      const idSuffix = String(Date.now()).slice(-4);
      const multiSource = activeSrcs.length > 1;

      const newMtg = {
        id: "mtg-" + idSuffix,
        kind: "meeting",
        project: state.settings.defaultProject,
        customTitle: false,
        title: "",
        createdAt: new Date().toISOString(),
        dateIso: "2026-11-11",
        dateGroup: "Oggi",
        dateShort: `Oggi, ${hhmm}`,
        dateFull: `11 nov 2026, ${hhmm}`,
        durationSec: dur,
        lang: "IT",
        modelUsed: `${state.settings.model} · ${multiSource ? "Canali isolati" : "Diarizzazione locale"}`,
        sourceApp: `👥 ${activeSrcs.length} font${activeSrcs.length === 1 ? "e" : "i"}`,
        pinned: false,
        audioVault: {
          folder: `/meeting_audio/2026-11-11_mtg-${idSuffix}/`,
          sizeMb: `${Math.max(1.2, (dur * 0.08).toFixed(1))} MB`,
          tracks: [
            { id: "mix", label: "🔊 Mix completo" },
            ...activeSrcs.map((s) => ({ id: s.id, label: `Solo ${s.channelTag}` })),
          ],
        },
        speakers: [
          {
            id: "spk-1",
            label: "Voce 1",
            sourceId: activeSrcs[0].id,
            sourceBadge: activeSrcs[0].channelTag,
          },
          {
            id: "spk-2",
            label: "Voce 2",
            sourceId: (activeSrcs[1] || activeSrcs[0]).id,
            sourceBadge: multiSource
              ? activeSrcs[1].channelTag
              : `${activeSrcs[0].channelTag} (Diarizz. locale)`,
          },
        ],
        utterances: [
          {
            id: "u-" + Date.now() + "-1",
            speakerId: "spk-1",
            startSec: 2,
            timeLabel: "00:02",
            lang: "IT",
            overlapType: null,
            text: "Registrazione riunione avviata: verifichiamo l'allineamento sulle prossime consegne della settimana.",
          },
          {
            id: "u-" + Date.now() + "-2",
            speakerId: "spk-2",
            startSec: 11,
            timeLabel: "00:11",
            lang: "IT",
            overlapType: multiSource ? "isolated_sources" : "same_source_local",
            text: "Confermo che l'audio della riunione è stato salvato nella memoria dedicata e separato per voce.",
          },
        ],
        passes: [],
        summaries: {},
      };

      state.notes.unshift(newMtg);
      state.selectedNoteId = newMtg.id;
      state.activeViewMode = "original";
      setAppStatus("idle");
      renderAll();
      showToast("Riunione trascritta e audio salvato in memoria dedicata");
    }, 1100);
  }
}

/* ==========================================================================
   06. RENDERING SIDEBAR E FONTI AUDIO
   ========================================================================== */
function renderSidebarControls() {
  const options = ["AUTO", ...state.settings.activeLanguages];
  if (!options.includes(state.dictationLang)) state.dictationLang = "AUTO";

  el.dictationLangPills.innerHTML = options
    .map((code) => {
      const selected = state.dictationLang === code;
      return `<button type="button" class="dictation-pill ${selected ? "is-selected" : ""}" data-dictation-lang="${code}">${code === "AUTO" ? "Auto" : code}</button>`;
    })
    .join("");

  const activeSrcs = getEnabledAudioSources();
  el.audioVaultBadge.textContent = `${activeSrcs.length} attiv${activeSrcs.length === 1 ? "a" : "e"}`;
  el.activeSourcesSummaryText.textContent =
    activeSrcs.length > 1
      ? `🎛 ${activeSrcs.length} fonti attive (Canali separati)`
      : activeSrcs.length === 1
      ? `🎙 1 fonte (${activeSrcs[0].channelTag} · Diarizz. locale)`
      : `⚠ Nessuna fonte audio attiva`;

  el.countAll.textContent = state.notes.length;
  el.countMeetings.textContent = state.notes.filter((n) => n.kind === "meeting").length;
  el.countPinned.textContent = state.notes.filter((n) => n.pinned).length;

  el.tabScopeAll.classList.toggle("is-active", state.scope === "all");
  el.tabScopeMeetings.classList.toggle("is-active", state.scope === "meetings");
  el.tabScopePinned.classList.toggle("is-active", state.scope === "pinned");

  ["IT", "EN", "FR", "JA"].forEach((lang) => {
    const count = state.notes.filter((n) => n.lang === lang).length;
    const countSpan = document.querySelector(`[data-lang-count="${lang}"]`);
    if (countSpan) countSpan.textContent = count;
    const chip = el.langFilterChips.querySelector(`[data-lang="${lang}"]`);
    if (chip) chip.classList.toggle("is-active", state.selectedLangFilters.has(lang));
  });

  el.btnResetLangFilter.hidden = state.selectedLangFilters.size === 0;
  el.vocabCountBadge.textContent = state.vocabulary.length;
  el.footerHotkeyBadge.textContent = state.settings.hotkey;
  el.placeholderHotkey.textContent = state.settings.hotkey;
}

/* ==========================================================================
   07. RENDERING LISTA NOTE E RIUNIONI (Colonna Centrale)
   ========================================================================== */
function getFilteredNotes() {
  const q = state.searchQuery.trim().toLowerCase();

  return state.notes.filter((note) => {
    if (state.tagFilter && !tagsOf(note).includes(state.tagFilter)) return false;
    if (state.scope === "meetings" && note.kind !== "meeting") return false;
    if (state.scope === "pinned" && !note.pinned) return false;

    if (state.selectedLangFilters.size > 0 && !state.selectedLangFilters.has(note.lang)) {
      return false;
    }

    if (q) {
      const hay = [
        getEffectiveTitle(note),
        getNotePlainTranscript(note), note.extraContext || "", ...(note.autoTags || []), ...(note.manualTags || []), ...(note.speakers || []).map(s=>s.label), ...(note.attachments || []).map(a=>a.title+" "+(a.url||"")),
        note.project || "",
        note.sourceApp || "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderNotesList() {
  const filtered = getFilteredNotes();
  const titles = { all: "Tutte le note", meetings: "Riunioni registrate", pinned: " Elementi fissati" };
  el.notesHeaderTitle.textContent = titles[state.scope] || "Note";

  const hasFilters = state.searchQuery.trim() !== "" || state.selectedLangFilters.size > 0 || state.scope !== "all";
  el.activeFilterSummary.hidden = !hasFilters;
  if (hasFilters) el.activeFilterSummary.textContent = `${filtered.length} di ${state.notes.length}`;

  if (!filtered.length) {
    el.notesList.hidden = true;
    el.notesEmpty.hidden = false;
    return;
  }

  el.notesList.hidden = false;
  el.notesEmpty.hidden = true;

  const groups = [];
  const pinned = state.scope === "all" ? filtered.filter((n) => n.pinned) : [];
  const rest = state.scope === "all" ? filtered.filter((n) => !n.pinned) : filtered;
  if (pinned.length) groups.push({ label: "📌 Fissate", items: pinned });

  const byDate = new Map();
  rest.forEach((n) => {
    const g = n.dateGroup || "Recenti";
    if (!byDate.has(g)) byDate.set(g, []);
    byDate.get(g).push(n);
  });
  for (const [label, items] of byDate.entries()) groups.push({ label, items });

  let html = "";
  for (const group of groups) {
    html += `<div class="notes-group-label">${escapeHtml(group.label)}</div>`;
    for (const note of group.items) {
      const previewSource = getNotePlainTranscript(note);
      const stats = computeTextStats(getNoteRawBodyOnly(note), note.lang);
      const isSelected = note.id === state.selectedNoteId;
      const isConfirming = note.id === state.pendingDeleteCardId;
      const isMeeting = note.kind === "meeting";

      html += `
        <article class="note-card ${isSelected ? "is-selected" : ""}" data-note-id="${note.id}" role="option" aria-selected="${isSelected}">
          <div class="note-card-top">
            <h3 class="note-card-title">${highlightQuery(getEffectiveTitle(note), state.searchQuery)}</h3>
            <div class="note-card-badges">
              <div class="card-hover-actions">
                <button type="button" class="card-icon-btn" data-card-action="pin" data-note-id="${note.id}" title="Fissa">📌</button>
                <button type="button" class="card-icon-btn card-delete-btn" data-card-action="ask-delete" data-note-id="${note.id}" title="Elimina">🗑</button>
              </div>
              ${isMeeting ? `<span class="meeting-card-pill">👥 ${note.speakers.length} voci</span>` : ""}
              <span class="lang-badge" data-lang="${note.lang}">${note.lang}</span>
            </div>
          </div>

          <p class="note-card-preview">${highlightQuery(previewSource || "Nota vuota…", state.searchQuery)}</p>

          <div class="note-card-meta">
            <span>📅 ${escapeHtml(note.dateShort)}</span>
            <span>·</span>
            <span>⏱ ${formatDuration(note.durationSec)}</span>
            <span>·</span>
            <span>${stats.words} par.</span>
            ${isMeeting ? `<span class="card-passes-pill">🔊 Audio</span>` : ""}
            ${!isMeeting && note.passes.length > 1 ? `<span class="card-passes-pill">${note.passes.length} passate</span>` : ""}
            ${note.project ? `<span class="card-passes-pill">#${escapeHtml(note.project)}</span>` : ""}
          </div>

          ${
            isConfirming
              ? `
            <div class="card-inline-confirm" data-confirm-box="${note.id}">
              <span>Eliminare definitivamente?</span>
              <div class="card-confirm-btns">
                <button type="button" class="btn-confirm-yes" data-card-action="confirm-delete" data-note-id="${note.id}">Elimina</button>
                <button type="button" class="btn-confirm-no" data-card-action="cancel-delete" data-note-id="${note.id}">No</button>
              </div>
            </div>`
              : ""
          }
        </article>
      `;
    }
  }
  el.notesList.innerHTML = html;
}

/* ==========================================================================
   08. RENDERING DETTAGLIO: PASSATE / CHAT RIUNIONE / RIASSUNTI STRUTTURATI
   ========================================================================== */
function getSelectedNote() {
  return state.notes.find((n) => n.id === state.selectedNoteId) || null;
}

function updateDetailMetadata(note) {
  if (!note) return;
  const stats = computeTextStats(getNoteRawBodyOnly(note), note.lang);
  const isMeeting = note.kind === "meeting";

  if (document.activeElement !== el.detailTitleInput) {
    el.detailTitleInput.value = getEffectiveTitle(note);
  }
  if (document.activeElement !== el.detailProjectInput) {
    el.detailProjectInput.value = note.project || "";
  }
  el.btnResetAutoTitle.hidden = !note.customTitle;

  el.detailKindPill.textContent = isMeeting ? "👥 Riunione Chat" : "✍️ Nota Dettata";
  el.detailKindPill.classList.toggle("is-meeting", isMeeting);
  el.detailSourcePill.textContent = note.sourceApp || "📝 App";
  el.detailModelPill.textContent = note.modelUsed || state.settings.model;
  el.btnTogglePinDetail.classList.toggle("is-pinned", Boolean(note.pinned));

  el.metaDate.textContent = `📅 ${note.dateFull}`;
  el.metaDuration.textContent = `⏱ ${formatDuration(note.durationSec)}`;
  el.metaLang.textContent = `🏷 ${note.lang}`;
  el.metaStats.textContent = `${stats.chars} caratteri · ${stats.words} parole`;

  // Pulsante "Aggiungi dettatura qui" solo per note di dettatura
  el.btnAppendPass.hidden = isMeeting;
}

function renderMeetingInspector(note) {
  if (!note || note.kind !== "meeting") {
    el.meetingInspectorBand.hidden = true;
    return;
  }
  el.meetingInspectorBand.hidden = false;

  // Audio player
  if(el.audioVaultPath) el.audioVaultPath.textContent = `💾 Memoria dedicata: ${note.audioVault.folder} · ${note.audioVault.sizeMb}`;
  el.audioTimeTotal.textContent = formatDuration(note.durationSec);
  el.audioScrubber.max = note.durationSec;
  el.audioScrubber.value = Math.min(state.audioCurrentSec, note.durationSec);
  el.audioTimeCurrent.textContent = formatDuration(el.audioScrubber.value);

  el.audioTrackSelect.innerHTML = note.audioVault.tracks
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`)
    .join("");

  // Strip Voci (Voce 1, Voce 2, … cliccabili per rinomina rapida)
  const spkColors = ["var(--spk-1)", "var(--spk-2)", "var(--spk-3)", "var(--spk-4)"];
  el.speakersStrip.innerHTML =
    `<span class="speakers-strip-label">Voci distinte (clicca per rinominare):</span>` +
    note.speakers
      .map(
        (spk, idx) => `
        <button type="button" class="speaker-chip" data-rename-speaker="${spk.id}" title="Clicca per assegnare un nome a ${escapeHtml(spk.label)}">
          <span class="speaker-dot" style="background:${spkColors[idx % spkColors.length]}"></span>
          <span>${escapeHtml(spk.label)}</span>
          <span class="speaker-ch-hint">· ${escapeHtml(spk.sourceBadge)}</span>
        </button>
      `
      )
      .join("");
}

function renderDetailPane() {
  queueMicrotask(renderV3);
  hideSelectionPopover();
  stopSimulatedAudioPlayback();
  state.detailDeleteConfirmOpen = false;
  el.detailConfirmGroup.hidden = true;
  el.btnDeleteDetail.hidden = false;

  const note = getSelectedNote();
  if (!note) {
    el.detailPlaceholder.hidden = false;
    el.detailContentWrap.hidden = true;
    return;
  }

  el.detailPlaceholder.hidden = true;
  el.detailContentWrap.hidden = false;

  updateDetailMetadata(note);
  renderMeetingInspector(note);

  // Aggiorna stato pillole modalità riassunto
  el.summaryModePills.querySelectorAll("[data-view-mode]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.viewMode === state.activeViewMode);
  });
  el.chkIncludeYaml.checked = state.includeYamlFrontmatter;
  el.btnRegenerateSummary.hidden = state.activeViewMode === "original";

  // Applica font scelto
  el.passesEditor.dataset.font = state.editorFont;
  el.meetingChatTimeline.dataset.font = state.editorFont;
  el.structuredSummaryView.dataset.font = state.editorFont;

  // VISTA A: Originale (Chat per Riunione, Passate per Dettatura)
  if (state.activeViewMode === "original") {
    el.structuredSummaryView.hidden = true;

    if (note.kind === "meeting") {
      el.passesEditor.hidden = true;
      el.meetingChatTimeline.hidden = false;
      renderMeetingChatBubbles(note);
    } else {
      el.meetingChatTimeline.hidden = true;
      el.passesEditor.hidden = false;
      renderDictationPasses(note);
    }
  } else {
    // VISTA B: Riassunto / Template Strutturato (POH, Brainstorming, Nota Lavoro, ecc.)
    el.passesEditor.hidden = true;
    el.meetingChatTimeline.hidden = true;
    el.structuredSummaryView.hidden = false;

    const mode = state.activeViewMode;
    el.summaryMethodBanner.textContent = SUMMARY_METHOD_DESCRIPTIONS[mode] || "";

    if (!note.summaries) note.summaries = {};
    if (!note.summaries[mode]) {
      note.summaries[mode] = buildStructuredTransform(note, mode);
    }
    el.summaryEditableSurface.textContent = note.summaries[mode];
  }
}

function renderDictationPasses(note) {
  el.passesEditor.innerHTML = note.passes
    .map((pass, idx) => {
      const divider =
        note.passes.length > 1
          ? `
          <div class="pass-divider" contenteditable="false">
            <span class="pass-divider-pill">
              <span>Passata ${idx + 1} · ${escapeHtml(pass.time)}</span>
              <span>·</span>
              <span>⏱ ${formatDuration(pass.durationSec)}</span>
              <span>·</span>
              <strong>${escapeHtml(pass.lang || note.lang)}</strong>
              ${idx > 0 ? `<button type="button" class="pass-merge-btn" data-merge-pass-index="${idx}">↑ Unisci</button>` : ""}
            </span>
          </div>`
          : "";

      return `
        <div class="pass-block">
          ${divider}
          <div class="pass-editable" contenteditable="true" spellcheck="true" data-pass-index="${idx}" data-placeholder="Clicca qui per scrivere…">${escapeHtml(pass.text)}</div>
        </div>
      `;
    })
    .join("");
}

function renderMeetingChatBubbles(note) {
  el.meetingChatTimeline.innerHTML = note.utterances
    .map((u, idx) => {
      const spkIdx = Math.max(0, note.speakers.findIndex((s) => s.id === u.speakerId));
      const spk = note.speakers[spkIdx] || { label: "Voce 1", sourceBadge: "CH1" };
      const initials = spk.label.replace(/\s+/g, "").slice(0, 2).toUpperCase();

      let overlapBadge = "";
      if (u.overlapType === "isolated_sources") {
        overlapBadge = `
          <div class="overlap-callout is-isolated">
            ⚡ Voci sovrapposte · Fonti diverse analizzate su canali separati (zero interferenza)
          </div>`;
      } else if (u.overlapType === "same_source_local") {
        overlapBadge = `
          <div class="overlap-callout is-same-source">
            🔀 Voci sovrapposte sulla stessa fonte · Distinte in locale (${escapeHtml(state.settings.diarizationModel === "pyannote_overlap" ? "Pyannote + MossFormer2" : "Sherpa-ONNX")})
          </div>`;
      }

      return `
        <div class="chat-turn ${u.overlapType ? "is-overlapped" : ""}" data-spk-idx="${spkIdx % 4}" data-turn-index="${idx}">
          <div class="chat-avatar">${escapeHtml(initials)}</div>
          <div class="chat-bubble">
            <div class="chat-bubble-header">
              <div class="chat-meta-left">
                <button type="button" class="chat-speaker-name" data-rename-speaker="${spk.id}" title="Clicca per rinominare questa voce">
                  ${escapeHtml(spk.label)}
                </button>
                <span class="chat-source-tag">${escapeHtml(spk.sourceBadge)}</span>
              </div>
              <button type="button" class="chat-time-btn" data-seek-sec="${u.startSec}" title="Salta a questo punto nella registrazione audio">
                ▶ ${escapeHtml(u.timeLabel)}
              </button>
            </div>
            ${overlapBadge}
            <div class="chat-utterance-text" contenteditable="true" spellcheck="true" data-utterance-index="${idx}">${wordMarkup(u, note, idx)}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

/* ==========================================================================
   09. PLAYER AUDIO RIUNIONE & RINOMINA VOCI (Voce 1 -> Nome reale)
   ========================================================================== */
function toggleSimulatedAudioPlayback() {
  const note = getSelectedNote();
  if (!note || note.kind !== "meeting") return;

  if (state.audioPlaying) {
    stopSimulatedAudioPlayback();
    return;
  }

  state.audioPlaying = true;
  el.audioPlayIcon.textContent = "⏸";

  audioPlayInterval = setInterval(() => {
    state.audioCurrentSec += 0.1 * (AUDIO_SPEEDS[state.audioSpeedIndex] || 1);
    if (state.audioCurrentSec >= note.durationSec) {
      state.audioCurrentSec = 0;
      stopSimulatedAudioPlayback();
      return;
    }
    el.audioScrubber.value = state.audioCurrentSec;
    el.audioTimeCurrent.textContent = formatDuration(state.audioCurrentSec);
      syncKaraoke();
  }, 100);
}

function stopSimulatedAudioPlayback() {
  clearInterval(audioPlayInterval);
  state.audioPlaying = false;
  if (el.audioPlayIcon) el.audioPlayIcon.textContent = "▶";
}

function promptRenameSpeaker(speakerId) {
  const note = getSelectedNote();
  if (!note || note.kind !== "meeting") return;
  const spk = note.speakers.find((s) => s.id === speakerId);
  if (!spk) return;

  // Rinomina inline rapida all'interno del chip cliccato
  const chip = el.speakersStrip.querySelector(`[data-rename-speaker="${speakerId}"]`);
  if (!chip || chip.querySelector("input")) return;

  const oldName = spk.label;
  chip.innerHTML = `<input type="text" class="project-tag-input" style="width:95px;font-weight:700" value="${escapeHtml(oldName)}" />`;
  const input = chip.querySelector("input");
  input.focus();
  input.select();

  const commit = () => {
    const next = input.value.trim() || oldName;
    spk.label = next;
    // Invalida i riassunti cached per riflettere il nuovo nome partecipante nel frontmatter YAML e azioni POH!
    note.summaries = {};
    renderDetailPane();
    renderNotesList();
    triggerAutosaveIndicator(note);
  };

  input.addEventListener("blur", commit, { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      input.value = oldName;
      input.blur();
    }
  });
}

function triggerAutosaveIndicator(note) {
  el.autosaveIndicator.classList.add("is-saving");
  el.autosaveText.textContent = "Salvataggio…";
  clearTimeout(autosaveTimeout);
  autosaveTimeout = setTimeout(() => {
    persistV3();
    callBackend(TAURI_COMMANDS.SAVE_NOTE, { note });
    el.autosaveIndicator.classList.remove("is-saving");
    el.autosaveText.textContent = "Salvato";
  }, 350);
}

/* ==========================================================================
   10. POPOVER CONTESTUALE DI SELEZIONE TESTO (Funziona su Passate, Chat e Riassunti)
   ========================================================================== */
let currentSelectedRaw = "";
let currentVocabCandidate = "";

function hideSelectionPopover() {
  el.selectionPopover.hidden = true;
  currentSelectedRaw = "";
  currentVocabCandidate = "";
}

function evaluateSelectionPopover() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideSelectionPopover();
    return;
  }

  const range = sel.getRangeAt(0);
  const insideEditable =
    el.passesEditor.contains(range.commonAncestorContainer) ||
    el.meetingChatTimeline.contains(range.commonAncestorContainer) ||
    el.summaryEditableSurface.contains(range.commonAncestorContainer);

  if (!insideEditable) {
    hideSelectionPopover();
    return;
  }

  const rawText = sel.toString();
  if (!rawText.trim()) {
    hideSelectionPopover();
    return;
  }

  currentSelectedRaw = rawText;
  currentVocabCandidate = normalizeVocabCandidate(rawText);

  el.btnPopoverAddVocab.classList.remove("is-added", "is-exists", "is-too-long");
  el.btnPopoverAddVocab.disabled = false;
  el.popoverCopyIcon.textContent = "📋";
  el.popoverCopyLabel.textContent = "Copia";

  const exists = state.vocabulary.some(
    (v) => v.term.toLowerCase() === currentVocabCandidate.toLowerCase()
  );
  const tooLong = currentVocabCandidate.length > 52 || currentVocabCandidate.includes("\n");

  if (!currentVocabCandidate || tooLong) {
    el.popoverTermPreview.textContent = `${rawText.trim().length} caratteri selezionati`;
    el.popoverVocabIcon.textContent = "ℹ️";
    el.popoverVocabLabel.textContent = "Troppo lungo per vocabolario";
    el.btnPopoverAddVocab.classList.add("is-too-long");
    el.btnPopoverAddVocab.disabled = true;
  } else if (exists) {
    el.popoverTermPreview.textContent = `“${currentVocabCandidate}”`;
    el.popoverVocabIcon.textContent = "✓";
    el.popoverVocabLabel.textContent = "Già nel vocabolario";
    el.btnPopoverAddVocab.classList.add("is-exists");
    el.btnPopoverAddVocab.disabled = true;
  } else {
    el.popoverTermPreview.textContent = `Termine: “${currentVocabCandidate}”`;
    el.popoverVocabIcon.textContent = "➕";
    el.popoverVocabLabel.textContent = "Aggiungi al vocabolario";
  }

  el.selectionPopover.hidden = false;
  const rect = range.getBoundingClientRect();
  const containerRect = el.editorScrollArea.getBoundingClientRect();
  const popWidth = el.selectionPopover.offsetWidth || 250;
  const popHeight = el.selectionPopover.offsetHeight || 62;

  let centerX = rect.left - containerRect.left + rect.width / 2 + el.editorScrollArea.scrollLeft;
  centerX = Math.max(popWidth / 2 + 12, Math.min(el.editorScrollArea.clientWidth - popWidth / 2 - 12, centerX));

  const spaceAbove = rect.top - containerRect.top;
  let topY;
  if (spaceAbove < popHeight + 16) {
    topY = rect.bottom - containerRect.top + el.editorScrollArea.scrollTop + 10;
    el.selectionPopover.classList.add("is-below");
  } else {
    topY = rect.top - containerRect.top + el.editorScrollArea.scrollTop - popHeight - 10;
    el.selectionPopover.classList.remove("is-below");
  }

  el.selectionPopover.style.left = `${centerX}px`;
  el.selectionPopover.style.top = `${topY}px`;
}

/* ==========================================================================
   11. MODALI: VOCABOLARIO E IMPOSTAZIONI (CON SELEZIONE FONTI AUDIO MULTIPLE)
   ========================================================================== */
function renderAudioSourcesSettings() {
  el.audioSourcesList.innerHTML = state.audioSources
    .map(
      (src) => `
      <label class="audio-source-card ${src.enabled ? "is-enabled" : ""}">
        <div class="audio-source-left">
          <input type="checkbox" data-toggle-source="${src.id}" ${src.enabled ? "checked" : ""} />
          <div class="audio-source-meta">
            <span class="audio-source-name">${escapeHtml(src.name)}</span>
            <span class="audio-source-desc">${escapeHtml(src.description)}</span>
          </div>
        </div>
        <div class="audio-source-right">
          <span class="ch-isolation-pill">${escapeHtml(src.channelTag)}</span>
        </div>
      </label>
    `
    )
    .join("");
}

function openSettingsTab(tabName = "audio") {
  renderAudioSourcesSettings();
  el.settingModel.value = state.settings.model;
  el.settingDiarization.value = state.settings.diarizationModel;
  el.settingLlmProvider.value = state.settings.llmProvider;
  if(el.settingDefaultProject) el.settingDefaultProject.value = state.settings.defaultProject;
  el.hotkeyDisplay.textContent = state.settings.hotkey;
  el.settingTheme.value = state.settings.theme;

  document.querySelectorAll('input[name="engine"]').forEach((r) => {
    r.checked = r.value === state.settings.engine;
  });
  document.querySelectorAll('input[name="pasteMode"]').forEach((r) => {
    r.checked = r.value === state.settings.pasteMode;
  });
  el.settingsLangCheckboxes.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = state.settings.activeLanguages.includes(cb.value);
  });

  switchSettingsTabUI(tabName);
  el.settingsModalBackdrop.hidden = false;
}

function switchSettingsTabUI(tabName) {
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.settingsTab === tabName);
  });
  document.getElementById("settingsPaneAudio").hidden = tabName !== "audio";
  document.getElementById("settingsPaneModels").hidden = tabName !== "models";
  for (const name of ["appearance", "tray"]) document.getElementById("settingsPane" + name[0].toUpperCase() + name.slice(1)).hidden = tabName !== name;
  document.getElementById("settingsPaneSystem").hidden = tabName !== "system";
}

function renderVocabularyModal() {
  const q = (el.vocabSearchInput.value || "").trim().toLowerCase();
  const filtered = state.vocabulary.filter(
    (v) => !q || v.term.toLowerCase().includes(q) || v.category.toLowerCase().includes(q)
  );

  const promptPreview = state.vocabulary.map((v) => v.term).join(", ");
  const approxTokens = Math.min(224, Math.ceil(promptPreview.length / 3.6));
  el.vocabStatsLabel.textContent = `${state.vocabulary.length} termini · ~${approxTokens}/224 token`;
  el.vocabTokenBar.style.width = `${Math.min(100, Math.round((approxTokens / 224) * 100))}%`;
  el.vocabCountBadge.textContent = state.vocabulary.length;

  const cats = ["Tecnici", "Nomi", "Acronimi", "Generale"];
  el.vocabGroupsContainer.innerHTML = cats
    .map((cat) => {
      const items = filtered.filter((v) => v.category === cat);
      if (!items.length) return "";
      return `
        <div class="vocab-group">
          <h4 class="vocab-group-title">${cat}</h4>
          <div class="vocab-chips-wrap">
            ${items
              .map(
                (item) => `
              <span class="vocab-term-chip">
                <span>${escapeHtml(item.term)}</span>
                <button type="button" class="vocab-remove-btn" data-remove-vocab="${item.id}">×</button>
              </span>`
              )
              .join("")}
          </div>
        </div>`;
    })
    .join("");
}

function addVocabularyTermsFromRaw(rawString, category = "Generale") {
  const parts = rawString.split(",").map(normalizeVocabCandidate).filter(Boolean);
  let added = 0;
  for (const term of parts) {
    if (!state.vocabulary.some((v) => v.term.toLowerCase() === term.toLowerCase())) {
      state.vocabulary.unshift({ id: "v-" + Date.now() + Math.random(), term, category });
      added++;
    }
  }
  if (added > 0) {
    callBackend(TAURI_COMMANDS.SAVE_VOCABULARY, { terms: state.vocabulary });
    renderVocabularyModal();
    renderSidebarControls();
  }
  return added;
}

/* ==========================================================================
   12. ELIMINAZIONE INLINE, TOAST UNDO ED ESPORTAZIONE .MD
   ========================================================================== */
function deleteNoteById(noteId) {
  const idx = state.notes.findIndex((n) => n.id === noteId);
  if (idx === -1) return;
  const [removed] = state.notes.splice(idx, 1);
  state.lastDeleted = { note: removed, idx };
  state.pendingDeleteCardId = null;

  if (state.selectedNoteId === noteId) {
    state.selectedNoteId = getFilteredNotes()[0]?.id || state.notes[0]?.id || null;
  }
  callBackend(TAURI_COMMANDS.DELETE_NOTE, { id: noteId });
  renderAll();

  showToast("Elemento eliminato", {
    undoLabel: "Annulla",
    onUndo: () => {
      if (!state.lastDeleted) return;
      state.notes.splice(state.lastDeleted.idx, 0, state.lastDeleted.note);
      state.selectedNoteId = state.lastDeleted.note.id;
      state.lastDeleted = null;
      renderAll();
    },
  });
}

function getCurrentActiveOutputText(note) {
  if (!note) return "";
  if (state.activeViewMode === "original") {
    return getNotePlainTranscript(note);
  }
  return note.summaries?.[state.activeViewMode] || buildStructuredTransform(note, state.activeViewMode);
}

function exportNoteAsMarkdown() {
  const note = getSelectedNote();
  if (!note) return;
  const mode = state.activeViewMode === "original" ? (note.kind === "meeting" ? "meeting_poh" : "work_note") : state.activeViewMode;
  const content =
    state.activeViewMode === "original"
      ? buildYamlFrontmatter(note, note.kind === "meeting" ? "trascrizione-riunione" : "dettatura") +
        `# ${getEffectiveTitle(note)}\n\n` +
        getNotePlainTranscript(note)
      : getCurrentActiveOutputText(note);

  const slug = getEffectiveTitle(note)
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "nota";

  const blob = new Blob([content + contextMarkdown(note)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${note.dateIso || "2026-11-11"}_${slug}_${mode}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Esportato ${a.download}`);
}

function showToast(message, options = {}) {
  clearTimeout(toastTimeout);
  el.toastRegion.innerHTML = `
    <div class="toast-item">
      <span>${escapeHtml(message)}</span>
      ${options.undoLabel ? `<button type="button" class="toast-undo-btn" id="btnToastUndo">${escapeHtml(options.undoLabel)}</button>` : ""}
    </div>
  `;
  if (options.onUndo) {
    document.getElementById("btnToastUndo")?.addEventListener("click", () => {
      options.onUndo();
      el.toastRegion.innerHTML = "";
    });
  }
  toastTimeout = setTimeout(() => {
    el.toastRegion.innerHTML = "";
  }, 4500);
}

function applyTheme(themePref) {
  state.settings.theme = themePref;
  document.documentElement.setAttribute("data-theme", themePref);
}

/* ==========================================================================
   13. EVENT LISTENERS E TASTIERA
   ========================================================================== */
function bindEvents() {
  // Modalità Dettatura vs Riunione
  el.btnModeDictation.addEventListener("click", () => setCaptureMode("dictation"));
  el.btnModeMeeting.addEventListener("click", () => setCaptureMode("meeting"));

  // Tema & Sidebar
  el.btnCycleTheme?.addEventListener("click", () => {
    const order = ["system", "light", "dark"];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    applyTheme(next);
    showToast(`Tema: ${next}`);
  });

  const toggleSidebar = () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    el.appShell.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
    el.btnExpandSidebar.hidden = !state.sidebarCollapsed;
  };
  el.btnToggleSidebar.addEventListener("click", toggleSidebar);
  el.btnExpandSidebar.addEventListener("click", toggleSidebar);

  // Controlli Dettatura
  el.btnNewVoiceNote.addEventListener("click", () => startDictationFlow("new"));
  el.btnAppendPass.addEventListener("click", () => startDictationFlow("append"));
  el.btnStopRecording.addEventListener("click", stopAndTranscribeDictation);
  el.btnCancelRecording.addEventListener("click", () => setAppStatus("idle"));

  // Controlli Riunione (Registra / Pausa / Ferma)
  el.btnStartMeeting.addEventListener("click", startMeetingFlow);
  el.btnPauseResumeMeeting.addEventListener("click", togglePauseMeetingFlow);
  el.btnStopMeeting.addEventListener("click", stopMeetingFlow);
  el.btnQuickAudioSources.addEventListener("click", () => openSettingsTab("audio"));
  el.btnOpenAudioVault.addEventListener("click", () => openSettingsTab("audio"));

  // Nuova nota vuota
  el.btnNewEmptyNote.addEventListener("click", () => {
    const hhmm = new Date().toTimeString().slice(0, 5);
    const n = {
      id: "note-" + Date.now(),
      kind: "dictation",
      project: state.settings.defaultProject,
      customTitle: false,
      title: "",
      createdAt: new Date().toISOString(),
      dateIso: "2026-11-11",
      dateGroup: "Oggi",
      dateShort: `Oggi, ${hhmm}`,
      dateFull: `11 nov 2026, ${hhmm}`,
      durationSec: 0,
      lang: state.dictationLang === "AUTO" ? "IT" : state.dictationLang,
      modelUsed: `${state.settings.model} · Metal`,
      sourceApp: "📝 App",
      pinned: false,
      passes: [{ id: "p-" + Date.now(), time: hhmm, durationSec: 0, lang: "IT", text: "" }],
      summaries: {},
    };
    state.notes.unshift(n);
    state.selectedNoteId = n.id;
    state.activeViewMode = "original";
    renderAll();
    el.passesEditor.querySelector(".pass-editable")?.focus();
  });

  // Lingua dettatura
  el.dictationLangPills.addEventListener("click", (e) => {
    const pill = e.target.closest("[data-dictation-lang]");
    if (!pill) return;
    state.dictationLang = pill.dataset.dictationLang;
    renderSidebarControls();
  });

  // Ricerca e filtri
  el.searchInput.addEventListener("input", () => {
    state.searchQuery = el.searchInput.value;
    el.btnClearSearch.hidden = !state.searchQuery;
    el.searchKbd.hidden = Boolean(state.searchQuery);
    renderNotesList();
  });
  el.btnClearSearch.addEventListener("click", () => {
    state.searchQuery = "";
    el.searchInput.value = "";
    el.btnClearSearch.hidden = true;
    el.searchKbd.hidden = false;
    renderNotesList();
  });

  [el.tabScopeAll, el.tabScopeMeetings, el.tabScopePinned].forEach((tab) => {
    tab.addEventListener("click", () => {
      state.scope = tab.dataset.scope;
      renderSidebarControls();
      renderNotesList();
    });
  });

  el.langFilterChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-lang]");
    if (!chip) return;
    const lang = chip.dataset.lang;
    if (state.selectedLangFilters.has(lang)) state.selectedLangFilters.delete(lang);
    else state.selectedLangFilters.add(lang);
    renderSidebarControls();
    renderNotesList();
  });

  el.btnResetLangFilter.addEventListener("click", () => {
    state.selectedLangFilters.clear();
    renderSidebarControls();
    renderNotesList();
  });

  el.btnClearAllFilters.addEventListener("click", () => {
    state.searchQuery = "";
    el.searchInput.value = "";
    state.scope = "all";
    state.selectedLangFilters.clear();
    renderAll();
  });

  // Demo stati
  document.querySelectorAll("[data-demo-state]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.demoState === "paused") setCaptureMode("meeting");
      setAppStatus(btn.dataset.demoState, { initialSeconds: 14 });
    });
  });

  // Click card lista note
  el.notesList.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-card-action]");
    if (actionBtn) {
      e.stopPropagation();
      const id = actionBtn.dataset.noteId;
      const act = actionBtn.dataset.cardAction;
      if (act === "pin") {
        const n = state.notes.find((x) => x.id === id);
        if (n) n.pinned = !n.pinned;
        renderAll();
      } else if (act === "ask-delete") {
        state.pendingDeleteCardId = id;
        renderNotesList();
      } else if (act === "confirm-delete") {
        deleteNoteById(id);
      } else if (act === "cancel-delete") {
        state.pendingDeleteCardId = null;
        renderNotesList();
      }
      return;
    }
    if (e.target.closest("[data-confirm-box]")) return;
    const card = e.target.closest(".note-card");
    if (!card) return;
    state.selectedNoteId = card.dataset.noteId;
    state.pendingDeleteCardId = null;
    state.audioCurrentSec = 0;
    hydrateNote(state.selectedNoteId).then(() => {
      renderNotesList();
      renderDetailPane();
    });
  });

  // Barra modalità riassunti (Originale / POH / Brainstorming / Nota Lavoro / ecc.)
  el.summaryModePills.addEventListener("click", async (e) => {
    const pill = e.target.closest("[data-view-mode]");
    if (!pill) return;
    const mode = pill.dataset.viewMode;
    state.activeViewMode = mode;

    const note = getSelectedNote();
    if (note && mode !== "original" && tauriInvoke) {
      const generated = await callBackend(TAURI_COMMANDS.GENERATE_SUMMARY, {
        provider: state.settings.llmProvider, model: state.settings.llmModel, extraContext: note.extraContext, attachments: note.attachments,
        noteId: note.id,
        mode,
        includeYaml: state.includeYamlFrontmatter,
      });
      if (generated) note.summaries[mode] = generated;
    }
    renderDetailPane();
  });

  el.chkIncludeYaml.addEventListener("change", () => {
    state.includeYamlFrontmatter = el.chkIncludeYaml.checked;
    const note = getSelectedNote();
    if (note) note.summaries = {};
    renderDetailPane();
  });

  el.btnRegenerateSummary.addEventListener("click", () => {
    const note = getSelectedNote();
    if (!note || state.activeViewMode === "original") return;
    note.summaries[state.activeViewMode] = buildStructuredTransform(note, state.activeViewMode);
    renderDetailPane();
    showToast("Riassunto rigenerato dalla trascrizione originale");
  });

  // Modifica progetto, titolo, passate, chat e riassunti
  el.detailProjectInput.addEventListener("input", () => {
    const note = getSelectedNote();
    if (!note) return;
    note.project = el.detailProjectInput.value.trim();
    note.summaries = {};
    renderNotesList();
    triggerAutosaveIndicator(note);
  });

  el.detailTitleInput.addEventListener("input", () => {
    const note = getSelectedNote();
    if (!note) return;
    note.customTitle = true;
    note.title = el.detailTitleInput.value;
    el.btnResetAutoTitle.hidden = false;
    renderNotesList();
    triggerAutosaveIndicator(note);
  });

  el.btnResetAutoTitle.addEventListener("click", () => {
    const note = getSelectedNote();
    if (!note) return;
    note.customTitle = false;
    note.title = "";
    updateDetailMetadata(note);
    renderNotesList();
  });

  el.passesEditor.addEventListener("input", (e) => {
    const ed = e.target.closest(".pass-editable");
    const note = getSelectedNote();
    if (!ed || !note) return;
    const idx = Number(ed.dataset.passIndex);
    if (note.passes[idx]) {
      note.passes[idx].text = ed.innerText;
      note.summaries = {};
      updateDetailMetadata(note);
      renderNotesList();
      triggerAutosaveIndicator(note);
      saveNoteTextBackend(note);
    }
  });

  el.meetingChatTimeline.addEventListener("input", (e) => {
    const ed = e.target.closest(".chat-utterance-text");
    const note = getSelectedNote();
    if (!ed || !note) return;
    const idx = Number(ed.dataset.utteranceIndex);
    if (note.utterances[idx]) {
      note.utterances[idx].text = ed.innerText;
      note.summaries = {};
      updateDetailMetadata(note);
      renderNotesList();
      triggerAutosaveIndicator(note);
    }
  });

  el.summaryEditableSurface.addEventListener("input", () => {
    const note = getSelectedNote();
    if (!note || state.activeViewMode === "original") return;
    note.summaries[state.activeViewMode] = el.summaryEditableSurface.innerText;
    triggerAutosaveIndicator(note);
  });

  // Unisci passate dettatura
  el.passesEditor.addEventListener("click", (e) => {
    const mergeBtn = e.target.closest("[data-merge-pass-index]");
    if (!mergeBtn) return;
    const note = getSelectedNote();
    if (!note || note.kind !== "dictation") return;
    const idx = Number(mergeBtn.dataset.mergePassIndex);
    if (idx > 0 && note.passes[idx]) {
      note.passes[idx - 1].text = [note.passes[idx - 1].text.trim(), note.passes[idx].text.trim()].filter(Boolean).join("\n\n");
      note.passes.splice(idx, 1);
      note.summaries = {};
      renderNotesList();
      renderDetailPane();
      triggerAutosaveIndicator(note);
      saveNoteTextBackend(note);
    }
  });

  // Incolla sempre testo puro in qualsiasi area contenteditable (passate, chat, riassunti)
  el.editorScrollArea.addEventListener("paste", (e) => {
    const target = e.target.closest("[contenteditable='true']");
    if (!target) return;
    e.preventDefault();
    const plain = (e.clipboardData || window.clipboardData).getData("text/plain");
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    selection.deleteFromDocument();
    selection.getRangeAt(0).insertNode(document.createTextNode(plain));
    selection.collapseToEnd();
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Rinomina voce e seek audio nella chat riunione
  el.speakersStrip.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rename-speaker]");
    if (btn) promptRenameSpeaker(btn.dataset.renameSpeaker);
  });

  el.meetingChatTimeline.addEventListener("click", (e) => {
    const renameBtn = e.target.closest("[data-rename-speaker]");
    if (renameBtn) {
      promptRenameSpeaker(renameBtn.dataset.renameSpeaker);
      return;
    }
    const seekBtn = e.target.closest("[data-seek-sec]");
    if (seekBtn) {
      state.audioCurrentSec = Number(seekBtn.dataset.seekSec) || 0;
      el.audioScrubber.value = state.audioCurrentSec;
      el.audioTimeCurrent.textContent = formatDuration(state.audioCurrentSec);
      if (!state.audioPlaying) toggleSimulatedAudioPlayback();
    }
  });

  // Player audio riunione
  el.btnAudioPlayPause.addEventListener("click", toggleSimulatedAudioPlayback);
  el.audioScrubber.addEventListener("input", () => {
    state.audioCurrentSec = Number(el.audioScrubber.value);
    el.audioTimeCurrent.textContent = formatDuration(state.audioCurrentSec);
  });
  el.btnAudioSpeed.addEventListener("click", () => {
    state.audioSpeedIndex = (state.audioSpeedIndex + 1) % AUDIO_SPEEDS.length;
    el.btnAudioSpeed.textContent = `${AUDIO_SPEEDS[state.audioSpeedIndex]}x`;
    if (state.audioPlaying) {
      stopSimulatedAudioPlayback();
      toggleSimulatedAudioPlayback();
    }
  });
  el.audioTrackSelect.addEventListener("change", () => {
    const label = el.audioTrackSelect.options[el.audioTrackSelect.selectedIndex]?.text || "";
    showToast(`Ascolto traccia: ${label}`);
  });

  // Font Sans / Mono + Pin
  document.querySelectorAll(".font-switch-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editorFont = btn.dataset.font;
      document.querySelectorAll(".font-switch-btn").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.font === state.editorFont);
      });
      renderDetailPane();
    });
  });

  el.btnTogglePinDetail.addEventListener("click", () => {
    const note = getSelectedNote();
    if (!note) return;
    note.pinned = !note.pinned;
    renderAll();
  });

  // Popover selezione
  document.addEventListener("selectionchange", () => requestAnimationFrame(evaluateSelectionPopover));
  el.selectionPopover.addEventListener("mousedown", (e) => e.preventDefault());

  el.btnPopoverAddVocab.addEventListener("click", () => {
    if (!currentVocabCandidate) return;
    if (addVocabularyTermsFromRaw(currentVocabCandidate, "Generale") > 0) {
      el.btnPopoverAddVocab.classList.add("is-added");
      el.popoverVocabIcon.textContent = "✓";
      el.popoverVocabLabel.textContent = "Aggiunto!";
      setTimeout(hideSelectionPopover, 800);
    }
  });

  el.btnPopoverCopy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentSelectedRaw); } catch {}
    el.popoverCopyIcon.textContent = "✓";
    el.popoverCopyLabel.textContent = "Copiato!";
    setTimeout(hideSelectionPopover, 600);
  });

  // Azioni Footer: Esporta .md, Copia tutto, Reinserisci, Elimina inline
  el.btnExportMarkdown.addEventListener("click", exportNoteAsMarkdown);

  el.btnCopyAll.addEventListener("click", async () => {
    const note = getSelectedNote();
    if (!note) return;
    const out = getCurrentActiveOutputText(note);
    try { await navigator.clipboard.writeText(out); } catch {}
    el.copyAllLabel.textContent = "Copiato ✓";
    showToast("Contenuto attivo copiato negli appunti");
    setTimeout(() => { el.copyAllLabel.textContent = "Copia tutto"; }, 1300);
  });

  el.btnReinsert.addEventListener("click", async () => {
    const note = getSelectedNote();
    if (!note) return;
    const out = getCurrentActiveOutputText(note);
    await callBackend(TAURI_COMMANDS.REINSERT_TEXT, { text: out, mode: state.settings.pasteMode });
    showToast(`Inviato al campo attivo (${state.settings.pasteMode})`);
  });

  el.btnDeleteDetail.addEventListener("click", () => {
    state.detailDeleteConfirmOpen = true;
    el.btnDeleteDetail.hidden = true;
    el.detailConfirmGroup.hidden = false;
  });
  el.btnCancelDeleteDetail.addEventListener("click", () => {
    state.detailDeleteConfirmOpen = false;
    el.detailConfirmGroup.hidden = true;
    el.btnDeleteDetail.hidden = false;
  });
  el.btnConfirmDeleteDetail.addEventListener("click", () => {
    if (state.selectedNoteId) deleteNoteById(state.selectedNoteId);
  });

  // Apertura/Chiusura Modali
  el.btnOpenVocab.addEventListener("click", () => {
    renderVocabularyModal();
    el.vocabModalBackdrop.hidden = false;
    el.vocabNewInput.focus();
  });
  el.btnOpenSettings.addEventListener("click", () => openSettingsTab("audio"));

  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsTabUI(btn.dataset.settingsTab));
  });

  // Toggle fonti audio multiple nelle impostazioni
  el.audioSourcesList.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-toggle-source]");
    if (!cb) return;
    const src = state.audioSources.find((s) => s.id === cb.dataset.toggleSource);
    if (src) {
      src.enabled = cb.checked;
      renderAudioSourcesSettings();
      renderSidebarControls();
      callBackend(TAURI_COMMANDS.SET_AUDIO_SOURCES, {
        activeSourceIds: getEnabledAudioSources().map((s) => s.id),
      });
    }
  });

  el.btnRefreshSources.addEventListener("click", async () => {
    await callBackend(TAURI_COMMANDS.LIST_AUDIO_SOURCES);
    showToast("Elenco dispositivi audio aggiornato");
  });

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.closeModal).hidden = true;
      isRecordingHotkey = false;
    });
  });

  [el.vocabModalBackdrop, el.settingsModalBackdrop].forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) bd.hidden = true;
    });
  });

  // Vocabolario form
  const submitVocab = (e) => {
    e.preventDefault();
    if (!el.vocabNewInput.value.trim()) return;
    addVocabularyTermsFromRaw(el.vocabNewInput.value, el.vocabCategorySelect.value);
    el.vocabNewInput.value = "";
  };
  el.vocabAddForm.addEventListener("submit", submitVocab);
  el.btnSubmitVocab.addEventListener("click", submitVocab);
  el.vocabSearchInput.addEventListener("input", renderVocabularyModal);
  el.vocabGroupsContainer.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove-vocab]");
    if (!rm) return;
    state.vocabulary = state.vocabulary.filter((v) => v.id !== rm.dataset.removeVocab);
    renderVocabularyModal();
    renderSidebarControls();
  });

  // Altre impostazioni
  el.settingModel.addEventListener("change", () => {
    state.settings.model = el.settingModel.value;
  });
  el.settingDiarization.addEventListener("change", () => {
    state.settings.diarizationModel = el.settingDiarization.value;
    renderDetailPane();
  });
  el.settingLlmProvider.addEventListener("change", () => {
    state.settings.llmProvider = el.settingLlmProvider.value;
  });
  el.settingDefaultProject?.addEventListener("input", () => {
    state.settings.defaultProject = el.settingDefaultProject.value.trim() || "generale";
  });
  el.settingTheme.addEventListener("change", () => applyTheme(el.settingTheme.value));

  el.settingsLangCheckboxes.addEventListener("change", () => {
    const checked = Array.from(el.settingsLangCheckboxes.querySelectorAll("input:checked")).map((c) => c.value);
    if (!checked.length) {
      const first = el.settingsLangCheckboxes.querySelector("input");
      first.checked = true;
      checked.push(first.value);
    }
    state.settings.activeLanguages = checked;
    renderSidebarControls();
  });

  el.btnHotkeyRecorder.addEventListener("click", () => {
    isRecordingHotkey = true;
    el.btnHotkeyRecorder.classList.add("is-listening");
    el.hotkeyHint.textContent = "Premi i tasti… (Esc annulla)";
  });

  // Tastiera globale (↑/↓, Canc, ⌘F, ⌘\, Esc)
  document.addEventListener("keydown", (e) => {
    if (isRecordingHotkey) {
      e.preventDefault();
      if (e.key === "Escape") {
        isRecordingHotkey = false;
        el.btnHotkeyRecorder.classList.remove("is-listening");
        el.hotkeyHint.textContent = "Clicca per cambiare";
        return;
      }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const mods = [];
      if (e.ctrlKey) mods.push("⌃");
      if (e.altKey) mods.push("⌥");
      if (e.shiftKey) mods.push("⇧");
      if (e.metaKey) mods.push("⌘");
      mods.push(e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      state.settings.hotkey = mods.join(" ");
      el.hotkeyDisplay.textContent = state.settings.hotkey;
      el.hotkeyHint.textContent = "Clicca per cambiare";
      isRecordingHotkey = false;
      el.btnHotkeyRecorder.classList.remove("is-listening");
      renderSidebarControls();
      return;
    }

    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      return;
    }
    if (isMod && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (e.key === "Escape") {
      el.vocabModalBackdrop.hidden = true;
      el.settingsModalBackdrop.hidden = true;
      hideSelectionPopover();
      state.pendingDeleteCardId = null;
      renderNotesList();
      return;
    }

    const active = document.activeElement;
    if (active && (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable)) {
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const visible = getFilteredNotes();
      if (!visible.length) return;
      const idx = visible.findIndex((n) => n.id === state.selectedNoteId);
      const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
      state.selectedNoteId = visible[next].id;
      renderNotesList();
      renderDetailPane();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!state.selectedNoteId) return;
      e.preventDefault();
      if (state.pendingDeleteCardId === state.selectedNoteId) deleteNoteById(state.selectedNoteId);
      else {
        state.pendingDeleteCardId = state.selectedNoteId;
        renderNotesList();
      }
    } else if (e.key === "Enter" && state.pendingDeleteCardId) {
      e.preventDefault();
      deleteNoteById(state.pendingDeleteCardId);
    }
  });
}

function renderAll() {
  prepareNotes();
  renderSidebarControls();
  renderNotesList();
  renderDetailPane();
  renderV3();
}

function init() {
  applyTheme(state.settings.theme);
  setCaptureMode("dictation");
  renderAll();
  bindEvents();
}

/* Stenon V3: browser demo; native features require the commands in SPEC_PER_AGENTE.md. */
const $ = id => document.getElementById(id);
const palettes = {light:{accent:'#2e86ab',bg:'#ffffff',text:'#111827'},dark:{accent:'#2e86ab',bg:'#1d242c',text:'#f1f5f9'}};
function tagsOf(n){return [...new Set([...(n.autoTags||[]),...(n.manualTags||[])])];}
function autoTags(n){const t=(getNotePlainTranscript(n)+' '+(n.extraContext||'')).toLowerCase();return Object.entries({riunione:/riunion|meeting|partecip/,budget:/budget|euro|preventiv/,sviluppo:/tauri|software|app|codic/,pianificazione:/lancio|scadenz|gennaio|pian/,audio:/audio|microfon|voce/,idee:/idea|propo|brainstorm/}).filter(([,r])=>r.test(t)).map(([k])=>k).slice(0,5);}
function prepareNotes(){state.notes.forEach(n=>{n.attachments ||= []; n.manualTags ||= []; n.extraContext ||= ''; if(state.settings.autoGenerateTags && !n.autoTags)n.autoTags=autoTags(n);});}
function initV3(){Object.assign(state.settings,{llmModel:'qwen2.5:7b',autoGenerateTags:true,dictationLanguages:[],lightColors:{...palettes.light},darkColors:{...palettes.dark},fontScale:1,highContrast:false,dyslexiaSpacing:false,strongFocus:true,trayEnabled:false,trayActions:['quick_dictate','quick_meeting','quick_new_note']});if(!REAL_BACKEND){try{const x=JSON.parse(localStorage.getItem('stenon.v3'));if(x){Object.assign(state.settings,x.settings);/* migrazione: vecchio selettore a lingua singola */if(typeof x.settings.dictationLanguage==='string'){state.settings.dictationLanguages=x.settings.dictationLanguage==='auto'?[]:[x.settings.dictationLanguage];delete state.settings.dictationLanguage;}if(x.notes?.length)state.notes=x.notes;}}catch{}}else{state.notes=[];state.selectedNoteId=null;}prepareNotes();applyAppearance();}
function persistV3(){if(REAL_BACKEND){try{localStorage.setItem('stenon.v3',JSON.stringify({settings:state.settings}));}catch{showToast('Impostazioni non salvate localmente.');}return;}try{localStorage.setItem('stenon.v3',JSON.stringify({settings:state.settings,notes:state.notes}));}catch{showToast('Spazio locale insufficiente: esporta la nota. Gli allegati grandi richiedono il vault Tauri.');}}
function saveV3(){persistV3();callBackend(TAURI_COMMANDS.SAVE_SETTINGS,{settings:state.settings});}
function applyAppearance(){const r=document.documentElement,s=state.settings;r.style.setProperty('--font-scale',s.fontScale);for(const mode of ['light','dark'])for(const key of ['accent','bg','text'])r.style.setProperty(`--user-${mode}-${key}`,s[mode+'Colors'][key]);r.dataset.highContrast=s.highContrast;r.dataset.wideSpacing=s.dyslexiaSpacing;r.dataset.strongFocus=s.strongFocus;}
function contextMarkdown(n){return '\n\n## Contesto aggiunto — non pronunciato\n\n'+(n.extraContext||'Nessuno.')+'\n\n'+(n.attachments||[]).map(a=>`${a.kind==='image'?'!':''}[${a.title.replace(/[\[\]]/g,'')}](${a.url||a.data})`).join('\n\n');}
const baseTransform=buildStructuredTransform;
buildStructuredTransform=function(n,m){return baseTransform(n,m)+contextMarkdown(n);};
function wordMarkup(u){const words=u.text.split(/\s+/).filter(Boolean);return words.map((w,k)=>`<span class="chat-word" data-word-index="${k}">${escapeHtml(w)}</span>`).join(' ');}
let lastTurn='';
function syncKaraoke(){const n=getSelectedNote();if(!n||n.kind!=='meeting')return;const t=state.audioCurrentSec;let current=null;document.querySelectorAll('[data-turn-index]').forEach(turn=>{const i=+turn.dataset.turnIndex,u=n.utterances[i],end=u.endSec||Math.min(n.utterances[i+1]?.startSec||n.durationSec,u.startSec+Math.max(4,u.text.split(/\s+/).length*.48));const active=t>=u.startSec&&t<end;turn.classList.toggle('is-speaking',active);const spans=turn.querySelectorAll('.chat-word');spans.forEach((sp,k)=>{const w=u.words?.[k];const start=w?w.start_ms/1000:u.startSec+(end-u.startSec)*k/spans.length,stop=w?w.end_ms/1000:u.startSec+(end-u.startSec)*(k+1)/spans.length;sp.classList.toggle('is-current-word',active&&t>=start&&t<stop);sp.classList.toggle('is-past-word',t>=stop);});if(active)current=turn;});$('audioTimeCurrent').textContent=formatDuration(t);$('audioScrubber').value=t;$('audioKaraokeStatus').textContent='Demo · tempi parola stimati';if(current&&$('chkAudioAutoScroll').checked&&lastTurn!==current.dataset.turnIndex){current.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'});lastTurn=current.dataset.turnIndex;}}
function renderV3(){const n=getSelectedNote();prepareNotes();const cloud=[...new Set(state.notes.flatMap(tagsOf))];$('sidebarTagsCloud').innerHTML=cloud.map(t=>`<button class="sidebar-tag-chip ${state.tagFilter===t?'is-active':''}" data-filter-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('');$('activeLlmLabel').textContent=state.settings.llmModel;
$('systemTrayWidget').hidden=!state.settings.trayEnabled;$('trayStateMini').textContent=state.appStatus;$('trayMenuStateLabel').textContent=state.appStatus;
const labels={quick_dictate:'🎙 Dettatura',quick_meeting:'👥 Riunione',quick_new_note:'✎ Nuova nota',quick_switch_lang:'🌐 Cambia lingua',quick_copy_last:'📋 Copia testo'};$('trayMenuActions').innerHTML=state.settings.trayActions.map(k=>`<button class="tray-action-item" data-tray-action="${k}">${labels[k]}</button>`).join('');
if(!n)return;$('detailTagsList').innerHTML=tagsOf(n).map(t=>`<span class="note-tag-pill">#${escapeHtml(t)} <button class="note-tag-remove" data-remove-tag="${escapeHtml(t)}" aria-label="Rimuovi tag ${escapeHtml(t)}">×</button></span>`).join('');$('extraContextTextarea').value=n.extraContext;$('attachmentsCountBadge').textContent=n.attachments.length;
$('attachmentsImagesGrid').innerHTML=n.attachments.filter(a=>a.kind==='image').map(a=>`<div class="attach-img-card"><img class="attach-img-thumb" src="${a.data}" alt="${escapeHtml(a.title)}" data-view-image="${a.id}" tabindex="0"><input class="attach-img-caption" data-caption="${a.id}" value="${escapeHtml(a.title)}" aria-label="Descrizione immagine"><button class="attach-remove-btn" data-remove-attachment="${a.id}" aria-label="Rimuovi allegato">×</button></div>`).join('');
$('attachmentsLinksList').innerHTML=n.attachments.filter(a=>a.kind!=='image').map(a=>`<div class="attach-link-card"><a class="attach-link-main" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer"><span>${a.kind==='pdf'?'📄':'🔗'}</span><span><strong>${escapeHtml(a.title)}</strong><div class="attach-link-url">${escapeHtml(a.url)}</div></span></a><button class="icon-btn" data-remove-attachment="${a.id}" aria-label="Rimuovi allegato">×</button></div>`).join('');}
function modelsUI(){const models={ollama:['qwen2.5:7b','llama3.2:3b','mistral-nemo:12b'],lmstudio:['Modello locale caricato'],llamacpp:['Modello GGUF configurato'],openai:['gpt-4o-mini','gpt-4o'],anthropic:['claude-sonnet-4']};const list=models[state.settings.llmProvider]||models.ollama;$('settingLlmModel').innerHTML=list.map(m=>`<option>${m}</option>`).join('');if(list.includes(state.settings.llmModel))$('settingLlmModel').value=state.settings.llmModel;else state.settings.llmModel=list[0];}
function bindV3(){const on=(id,ev,fn)=>$(id).addEventListener(ev,fn);const commit=()=>{const n=getSelectedNote();if(n){n.summaries={};triggerAutosaveIndicator(n);}persistV3();renderV3();};
on('btnOpenA11yQuick','click',()=>openSettingsTab('appearance'));on('btnQuickLlmBadge','click',()=>{modelsUI();openSettingsTab('models');});
on('btnAudioBack5','click',()=>{state.audioCurrentSec=Math.max(0,state.audioCurrentSec-5);lastTurn='';syncKaraoke();});on('btnAudioFwd5','click',()=>{state.audioCurrentSec=Math.min(getSelectedNote().durationSec,state.audioCurrentSec+5);lastTurn='';syncKaraoke();});on('audioScrubber','input',()=>{lastTurn='';syncKaraoke();});
on('sidebarTagsCloud','click',e=>{const b=e.target.closest('[data-filter-tag]');if(b){state.tagFilter=state.tagFilter===b.dataset.filterTag?'':b.dataset.filterTag;renderNotesList();renderV3();}});on('btnResetTagFilter','click',()=>{state.tagFilter='';renderAll();});on('btnClearAllFilters','click',()=>{state.tagFilter='';renderAll();});
on('newTagInlineInput','keydown',e=>{if(e.key==='Enter'){const t=e.target.value.trim().replace(/^#/,'');if(t){getSelectedNote().manualTags.push(t);e.target.value='';commit();}}});on('detailTagsList','click',e=>{const b=e.target.closest('[data-remove-tag]');if(b){const n=getSelectedNote();for(const k of ['autoTags','manualTags'])n[k]=(n[k]||[]).filter(t=>t!==b.dataset.removeTag);commit();}});on('btnGenerateAutoTags','click',async()=>{const n=getSelectedNote();const result=await callBackend('generate_auto_tags',{note:n,provider:state.settings.llmProvider,model:state.settings.llmModel});n.autoTags=Array.isArray(result)?result:autoTags(n);commit();showToast(tauriInvoke?'Tag aggiornati':'Tag demo estratti con regole locali, senza LLM');});
on('settingLlmProvider','change',()=>{modelsUI();saveV3();renderV3();});on('settingLlmModel','change',e=>{state.settings.llmModel=e.target.value;state.notes.forEach(n=>n.summaries={});saveV3();renderV3();});
// Lingue di trascrizione ammesse (reale: comanda il backend Whisper)
const dictationLangChips = document.getElementById('dictationLangChips');
if (dictationLangChips) {
  const syncLangChips = () => {
    const arr = state.settings.dictationLanguages || [];
    dictationLangChips.querySelectorAll('[data-dlang]').forEach(b => {
      b.classList.toggle('is-active', arr.includes(b.dataset.dlang));
      b.setAttribute('aria-pressed', arr.includes(b.dataset.dlang) ? 'true' : 'false');
    });
  };
  syncLangChips();
  dictationLangChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dlang]');
    if (!b) return;
    const arr = state.settings.dictationLanguages || (state.settings.dictationLanguages = []);
    const i = arr.indexOf(b.dataset.dlang);
    if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.dlang);
    saveV3();
    syncLangChips();
    if (REAL_BACKEND) callBackend(TAURI_COMMANDS.SET_LANGUAGES, { langs: arr });
  });
}
for(const [id,key] of [['chkAutoGenerateTags','autoGenerateTags'],['chkHighContrast','highContrast'],['chkDyslexiaSpacing','dyslexiaSpacing'],['chkStrongFocus','strongFocus'],['chkEnableSystemTray','trayEnabled']]){ $(id).checked=state.settings[key];on(id,'change',e=>{state.settings[key]=e.target.checked;applyAppearance();saveV3();renderV3();$('trayCustomizationSection').hidden=!state.settings.trayEnabled;if(key==='trayEnabled')callBackend('set_tray_enabled',{enabled:e.target.checked,actions:state.settings.trayActions});});}
for(const mode of ['light','dark'])for(const key of ['accent','bg','text']){const id='color'+mode[0].toUpperCase()+mode.slice(1)+key[0].toUpperCase()+key.slice(1);$(id).value=state.settings[mode+'Colors'][key];on(id,'input',e=>{state.settings[mode+'Colors'][key]=e.target.value;applyAppearance();saveV3();});}
on('fontScalePills','click',e=>{const b=e.target.closest('[data-scale]');if(b){state.settings.fontScale=+b.dataset.scale;document.querySelectorAll('[data-scale]').forEach(x=>x.classList.toggle('is-active',x===b));applyAppearance();saveV3();}});
on('palettePresetsRow','click',e=>{const b=e.target.closest('[data-palette]');if(b){const c={stenon:'#2e86ab',forest:'#287c55',indigo:'#6251b5',amber:'#946100'}[b.dataset.palette];state.settings.lightColors.accent=c;state.settings.darkColors.accent=c;applyAppearance();saveV3();$('colorLightAccent').value=c;$('colorDarkAccent').value=c;}});on('btnResetCustomColors','click',()=>{for(const m of ['light','dark']){state.settings[m+'Colors']={...palettes[m]};for(const k of ['accent','bg','text'])$('color'+m[0].toUpperCase()+m.slice(1)+k[0].toUpperCase()+k.slice(1)).value=palettes[m][k];}applyAppearance();saveV3();});
on('btnTrayTrigger','click',()=>{$('trayPopoverMenu').hidden=!$('trayPopoverMenu').hidden;});on('btnConfigureTray','click',()=>openSettingsTab('tray'));on('trayActionsChecklist','change',()=>{state.settings.trayActions=[...$('trayActionsChecklist').querySelectorAll('input:checked')].map(x=>x.value);saveV3();renderV3();callBackend('set_tray_actions',{actions:state.settings.trayActions});});on('trayMenuActions','click',e=>{const k=e.target.closest('[data-tray-action]')?.dataset.trayAction;if(k==='quick_dictate')$(state.appStatus==='recording'?'btnStopRecording':'btnNewVoiceNote').click();if(k==='quick_meeting')$(state.appStatus==='recording'?'btnPauseResumeMeeting':'btnStartMeeting').click();if(k==='quick_new_note')$('btnNewEmptyNote').click();if(k==='quick_switch_lang'){const a=['IT','EN','FR','JA'];state.dictationLang=a[(a.indexOf(state.dictationLang)+1)%4];renderAll();}if(k==='quick_copy_last')$('btnCopyAll').click();});
on('btnAddImage','click',()=>$('imageUploadInput').click());async function addImages(files){const n=getSelectedNote();for(const f of files){if(!/^image\/(png|jpeg|webp|gif)$/.test(f.type)){showToast('Usa immagini PNG, JPEG, WebP o GIF.');continue;}if(f.size>4*1024*1024){showToast('Limite demo: 4 MB per immagine.');continue;}const data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);});n.attachments.push({id:crypto.randomUUID(),kind:'image',title:f.name||'Screenshot incollato',data});}commit();}on('imageUploadInput','change',e=>{addImages(e.target.files);e.target.value='';});document.addEventListener('paste',e=>{if(!$('settingsModalBackdrop').hidden||!$('vocabModalBackdrop').hidden)return;const f=[...(e.clipboardData?.files||[])];if(f.some(x=>x.type.startsWith('image/'))&&getSelectedNote()){e.preventDefault();e.stopImmediatePropagation();addImages(f);} },true);
on('btnToggleAddLinkForm','click',()=>{$('addLinkInlineForm').hidden=!$('addLinkInlineForm').hidden;});on('btnCancelLinkForm','click',()=>$('addLinkInlineForm').hidden=true);on('addLinkInlineForm','submit',e=>{e.preventDefault();let url;try{url=new URL($('attachLinkUrl').value);if(!['https:','http:'].includes(url.protocol))throw Error();}catch{showToast('Inserisci un URL https:// o http:// valido.');return;}getSelectedNote().attachments.push({id:crypto.randomUUID(),kind:$('attachLinkKind').value,title:$('attachLinkTitle').value.trim()||url.hostname,url:url.href});$('addLinkInlineForm').hidden=true;$('attachLinkTitle').value='';$('attachLinkUrl').value='';commit();});on('btnToggleContextNote','click',()=>{$('extraContextBox').hidden=!$('extraContextBox').hidden;});on('extraContextTextarea','input',e=>{getSelectedNote().extraContext=e.target.value;getSelectedNote().summaries={};triggerAutosaveIndicator(getSelectedNote());});
on('attachmentsPanel','click',e=>{const rm=e.target.closest('[data-remove-attachment]'),im=e.target.closest('[data-view-image]');if(rm){getSelectedNote().attachments=getSelectedNote().attachments.filter(a=>a.id!==rm.dataset.removeAttachment);commit();}if(im){const a=getSelectedNote().attachments.find(a=>a.id===im.dataset.viewImage);$('lightboxImg').src=a.data;$('lightboxCaption').textContent=a.title;$('imageLightboxBackdrop').hidden=false;$('btnCloseLightbox').focus();}});on('attachmentsPanel','change',e=>{if(e.target.dataset.caption){getSelectedNote().attachments.find(a=>a.id===e.target.dataset.caption).title=e.target.value;commit();}});on('btnCloseLightbox','click',()=>$('imageLightboxBackdrop').hidden=true);document.addEventListener('keydown',e=>{if(e.key==='Escape')$('imageLightboxBackdrop').hidden=true;});
$('trayCustomizationSection').hidden=!state.settings.trayEnabled;modelsUI();window.addEventListener('beforeunload',persistV3);document.addEventListener('change',saveV3);
}

/* Fase A: in Tauri carica le note reali dal DB e resta in ascolto degli eventi;
   in browser puro resta il flusso demo. */
(async () => {
  initV3();
  if (REAL_BACKEND) {
    await loadRealNotes();
    // Applica le lingue di trascrizione salvate (vuoto = rilevamento libero)
    callBackend(TAURI_COMMANDS.SET_LANGUAGES, { langs: state.settings.dictationLanguages || [] });
    if (tauriListen) {
      await tauriListen("note-saved", () => {
        loadRealNotes().then(() => renderAll());
      });
    }
  }
  init();
  bindV3();
  renderV3();
})();
