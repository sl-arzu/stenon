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
}

#[derive(Debug, Serialize)]
pub struct SegmentRow {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct NoteDetail {
    pub id: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub mode: String,
    pub language: String,
    pub text: String,
    pub segments: Vec<SegmentRow>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'dettatura',
    audio_path TEXT,
    language TEXT
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
        let mut stmt = match self
            .conn
            .prepare("SELECT id, created_at, duration_ms, mode, language FROM notes ORDER BY created_at DESC")
        {
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
                Ok(NoteSummary {
                    id,
                    created_at,
                    duration_ms,
                    mode,
                    language,
                    preview: String::new(),
                })
            })
            .unwrap_or_else(|_| panic!("list_notes: query_map"));
        rows.filter_map(|r| r.ok()).collect()
    }

    /// Dettaglio di una nota: testo puro della trascrizione e segmenti.
    pub fn get_note(&self, id: &str) -> Option<NoteDetail> {
        let (created_at, duration_ms, mode, language): (i64, i64, String, String) = self
            .conn
            .query_row(
                "SELECT created_at, duration_ms, mode, language FROM notes WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    ))
                },
            )
            .ok()?;
        let mut segments = Vec::new();
        if let Ok(mut stmt) = self.conn.prepare(
            "SELECT start_ms, end_ms, text FROM segments WHERE track_id = ?1 ORDER BY start_ms",
        ) {
            // una sola traccia 'mic' in Fase 0: usa il primo track id della nota
            let track_id: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM tracks WHERE note_id = ?1 LIMIT 1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(track_id) = track_id {
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
                    segments.push(sr);
                }
            }
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
            text,
            segments,
        })
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
