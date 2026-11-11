//! Salvataggio delle dettature come note.

use crate::asr::Segment;
use crate::storage::db::Db;
use std::error::Error;

/// Salva una dettatura: nota + traccia mic + segmenti + versione raw.
/// Restituisce l'id della nota creata.
pub fn save_dictation(
    db: &Db,
    segments: &[Segment],
    language: &str,
    duration_ms: i64,
    mode: &str,
    audio_path: Option<&str>,
) -> Result<String, Box<dyn Error>> {
    if segments.is_empty() {
        return Err("nessun segmento da salvare".into());
    }
    let note_id = uuid::Uuid::new_v4().to_string();
    db.insert_note(&note_id, now_ms(), duration_ms, mode, audio_path, language)?;
    let track_id = uuid::Uuid::new_v4().to_string();
    db.insert_track(&track_id, &note_id, "mic", "Microfono")?;
    for s in segments {
        db.insert_segment(&track_id, s.start_ms, s.end_ms, &s.text)?;
    }
    let raw_text = segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    db.insert_version(&note_id, "raw", None, &raw_text)?;
    Ok(note_id)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_segments() {
        let db = Db::open_in_memory().unwrap();
        let result = save_dictation(&db, &[], "auto", 0, "dettatura", None);
        assert!(result.is_err());
    }
}
