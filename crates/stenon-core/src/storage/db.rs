//! Persistenza SQLite: note, tracce, segmenti, versioni.

use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

#[derive(Debug, Serialize)]
pub struct NoteSummary {
    pub id: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub mode: String,
    pub language: String,
    pub preview: String,
    pub title: Option<String>,
    pub pinned: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentRow {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Segmenti di una singola traccia (Fase C: mic / system).
#[derive(Debug, Serialize)]
pub struct TrackSegs {
    pub kind: String,
    pub label: String,
    pub segments: Vec<SegmentRow>,
}

#[derive(Debug, Serialize)]
pub struct NoteDetail {
    pub id: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub mode: String,
    pub language: String,
    pub audio_path: Option<String>,
    pub text: String,
    pub segments: Vec<SegmentRow>,
    /// Tutte le tracce con i loro segmenti (Fase C); vuota per le note vecchie.
    pub tracks: Vec<TrackSegs>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'dettatura',
    audio_path TEXT,
    language TEXT,
    title TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    kind TEXT NOT NULL,
    label TEXT
);
CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    parent_id TEXT,
    op TEXT NOT NULL,
    model TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

/// Migrazione leggera: aggiunge le colonne dei metadati (Fase B) ai database
/// creati con lo schema della Fase 0. Idempotente.
fn migrate(conn: &Connection) {
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(notes)")
        .and_then(|mut s| {
            s.query_map([], |row| row.get::<_, String>(1))
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    let alter = |sql: &str| {
        if let Err(e) = conn.execute_batch(sql) {
            eprintln!("db: migrazione fallita ({sql}): {e}");
        }
    };
    if !cols.iter().any(|c| c == "title") {
        alter("ALTER TABLE notes ADD COLUMN title TEXT;");
    }
    if !cols.iter().any(|c| c == "pinned") {
        alter("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;");
    }
    if !cols.iter().any(|c| c == "tags") {
        alter("ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';");
    }
}

impl Db {
    /// Apre (o crea) il database al percorso indicato.
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self { conn })
    }

    /// Apre un database in memoria (per i test).
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// Inserisce una nota e restituisce il suo id.
    pub fn insert_note(
        &self,
        id: &str,
        created_at: i64,
        duration_ms: i64,
        mode: &str,
        audio_path: Option<&str>,
        language: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO notes (id, created_at, duration_ms, mode, audio_path, language) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, created_at, duration_ms, mode, audio_path, language],
        )?;
        Ok(())
    }

    /// Inserisce una traccia audio collegata a una nota.
    pub fn insert_track(
        &self,
        id: &str,
        note_id: &str,
        kind: &str,
        label: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO tracks (id, note_id, kind, label) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, note_id, kind, label],
        )?;
        Ok(())
    }

    /// Inserisce un segmento di trascrizione collegato a una traccia.
    pub fn insert_segment(
        &self,
        track_id: &str,
        start_ms: i64,
        end_ms: i64,
        text: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO segments (id, track_id, start_ms, end_ms, text) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                track_id,
                start_ms,
                end_ms,
                text
            ],
        )?;
        Ok(())
    }

    /// Inserisce una versione (op = 'raw' | 'F' | 'D' | 'S' | 'A' | 'C').
    pub fn insert_version(
        &self,
        note_id: &str,
        op: &str,
        model: Option<&str>,
        text: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO versions (id, note_id, parent_id, op, model, text, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                note_id,
                Option::<String>::None,
                op,
                model,
                text,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// Elenco note per la UI (dal più recente).
    pub fn list_notes(&self) -> Vec<NoteSummary> {
        let mut stmt = match self.conn.prepare(
            "SELECT n.id, n.created_at, n.duration_ms, n.mode, n.language, \
                 n.title, n.pinned, n.tags, \
                 COALESCE( \
                   (SELECT v.text FROM versions v \
                    WHERE v.note_id = n.id AND v.op = 'edited' \
                    ORDER BY v.created_at DESC LIMIT 1), \
                   (SELECT group_concat(s.text, ' ') FROM segments s \
                    JOIN tracks t ON s.track_id = t.id WHERE t.note_id = n.id) \
                 ) AS body \
                 FROM notes n ORDER BY n.created_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let created_at: i64 = row.get(1)?;
                let duration_ms: i64 = row.get(2)?;
                let mode: String = row.get(3)?;
                let language: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
                let title: Option<String> = row
                    .get::<_, Option<String>>(5)?
                    .filter(|t| !t.trim().is_empty());
                let pinned: bool = row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0;
                let tags: Vec<String> =
                    serde_json::from_str(&row.get::<_, Option<String>>(7)?.unwrap_or_default())
                        .unwrap_or_default();
                // preview: testo completo (le note di dettatura sono brevi);
                // serve alla ricerca del frontend senza idratare ogni nota.
                let body: Option<String> = row.get(8)?;
                let mut preview = body.unwrap_or_default();
                preview.truncate(4000);
                Ok(NoteSummary {
                    id,
                    created_at,
                    duration_ms,
                    mode,
                    language,
                    preview,
                    title,
                    pinned,
                    tags,
                })
            })
            .unwrap_or_else(|_| panic!("list_notes: query_map"));
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Aggiorna i metadati di una nota (Fase B: titolo, pin, tag).
    /// `None` = lascia invariato il valore attuale.
    pub fn update_note_meta(
        &self,
        id: &str,
        title: Option<&str>,
        pinned: Option<bool>,
        tags: Option<&str>,
    ) -> bool {
        let mut ok = true;
        if let Some(t) = title {
            ok &= self
                .conn
                .execute(
                    "UPDATE notes SET title = ?1 WHERE id = ?2",
                    rusqlite::params![t, id],
                )
                .map(|n| n > 0)
                .unwrap_or(false);
        }
        if let Some(p) = pinned {
            ok &= self
                .conn
                .execute(
                    "UPDATE notes SET pinned = ?1 WHERE id = ?2",
                    rusqlite::params![p as i64, id],
                )
                .map(|n| n > 0)
                .unwrap_or(false);
        }
        if let Some(tg) = tags {
            ok &= self
                .conn
                .execute(
                    "UPDATE notes SET tags = ?1 WHERE id = ?2",
                    rusqlite::params![tg, id],
                )
                .map(|n| n > 0)
                .unwrap_or(false);
        }
        ok
    }

    /// Dettaglio di una nota: testo puro della trascrizione e segmenti.
    pub fn get_note(&self, id: &str) -> Option<NoteDetail> {
        let (created_at, duration_ms, mode, language, audio_path): (
            i64,
            i64,
            String,
            String,
            Option<String>,
        ) = self
            .conn
            .query_row(
                "SELECT created_at, duration_ms, mode, language, audio_path \
                 FROM notes WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        row.get(4)?,
                    ))
                },
            )
            .ok()?;
        // Tutte le tracce con i loro segmenti (Fase C). Retrocompatibile:
        // `segments` resta la prima traccia (mic nelle dettature).
        let mut segments = Vec::new();
        let mut tracks = Vec::new();
        if let Ok(mut stmt_tracks) = self
            .conn
            .prepare("SELECT id, kind, label FROM tracks WHERE note_id = ?1 ORDER BY rowid")
        {
            let track_rows: Vec<(String, String, String)> = stmt_tracks
                .query_map(rusqlite::params![id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();
            for (track_id, kind, label) in track_rows {
                let mut segs = Vec::new();
                if let Ok(mut stmt) = self.conn.prepare(
                    "SELECT start_ms, end_ms, text FROM segments \
                     WHERE track_id = ?1 ORDER BY start_ms",
                ) {
                    let rows = stmt
                        .query_map(rusqlite::params![track_id], |row| {
                            Ok(SegmentRow {
                                start_ms: row.get(0)?,
                                end_ms: row.get(1)?,
                                text: row.get(2)?,
                            })
                        })
                        .ok()?;
                    for sr in rows.flatten() {
                        segs.push(sr);
                    }
                }
                if segments.is_empty() {
                    segments = segs.clone();
                }
                tracks.push(TrackSegs { kind, label, segments: segs });
            }
        }
        // Se esiste una modifica manuale (op "edited"), vince sull'ultimo testo:
        // i timestamp dei segmenti non sono più allineati al testo modificato.
        let edited: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT text, created_at FROM versions \
                 WHERE note_id = ?1 AND op = 'edited' ORDER BY created_at DESC LIMIT 1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((edited_text, edited_at)) = edited {
            segments = vec![SegmentRow {
                start_ms: 0,
                end_ms: duration_ms,
                text: edited_text,
            }];
            let _ = edited_at;
        }
        let text = segments
            .iter()
            .map(|s| s.text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        Some(NoteDetail {
            id: id.to_string(),
            created_at,
            duration_ms,
            mode,
            language,
            audio_path,
            text,
            segments,
            tracks,
        })
    }

    /// Salva una modifica manuale al testo della nota (op "edited").
    /// La versione più recente di questo tipo sostituisce i segmenti in `get_note`.
    pub fn update_note_text(&self, id: &str, text: &str) -> bool {
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM notes WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .ok();
        if exists.is_none() {
            return false;
        }
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let version_id = format!("v-edited-{}-{}", created_at, id);
        self.conn
            .execute(
                "INSERT INTO versions (id, note_id, parent_id, op, model, text, created_at) \
                 VALUES (?1, ?2, NULL, 'edited', NULL, ?3, ?4)",
                rusqlite::params![version_id, id, text, created_at],
            )
            .is_ok()
    }

    /// Elimina una nota e i suoi dati collegati. Restituisce true se eliminata.
    pub fn delete_note(&self, id: &str) -> bool {
        let _ = self.conn.execute(
            "DELETE FROM segments WHERE track_id IN (SELECT id FROM tracks WHERE note_id = ?1)",
            rusqlite::params![id],
        );
        let _ = self.conn.execute(
            "DELETE FROM versions WHERE note_id = ?1",
            rusqlite::params![id],
        );
        let _ = self.conn.execute(
            "DELETE FROM tracks WHERE note_id = ?1",
            rusqlite::params![id],
        );
        self.conn
            .execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])
            .map(|n| n > 0)
            .unwrap_or(false)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
