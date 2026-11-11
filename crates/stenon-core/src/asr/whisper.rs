//! Implementazione Whisper (whisper-rs) del trait `Transcriber`.

use super::{Segment, Transcriber};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Trascrizione locale con whisper.cpp.
pub struct WhisperTranscriber {
    ctx: WhisperContext,
    lang: String,
}

impl WhisperTranscriber {
    /// Carica il modello ggml da `model_path`.
    pub fn new(model_path: &Path, language: &str) -> Result<Self, whisper_rs::WhisperError> {
        let path_str = model_path.to_str().ok_or_else(|| {
            eprintln!("stenon: percorso modello non valido UTF-8");
            whisper_rs::WhisperError::GenericError(-1)
        })?;
        let ctx = WhisperContext::new_with_params(
            path_str,
            WhisperContextParameters::default(),
        )?;
        Ok(Self {
            ctx,
            lang: language.to_string(),
        })
    }

    pub fn language(&self) -> &str {
        &self.lang
    }
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(&self, pcm: &[f32]) -> Vec<Segment> {
        if pcm.is_empty() {
            return Vec::new();
        }
        let mut state = match self.ctx.create_state() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("whisper: creazione stato fallita: {e}");
                return Vec::new();
            }
        };
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let _ = params.set_language(Some(&self.lang));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        if let Err(e) = state.full(params, pcm) {
            eprintln!("whisper: trascrizione fallita: {e}");
            return Vec::new();
        }

        let n = match state.full_n_segments() {
            Ok(n) => n,
            Err(e) => {
                eprintln!("whisper: segmenti non leggibili: {e}");
                return Vec::new();
            }
        };

        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let text = match state.full_get_segment_text(i) {
                Ok(t) => t.trim().to_string(),
                Err(_) => continue,
            };
            if text.is_empty() {
                continue;
            }
            let (t0, t1) = (
                state.full_get_segment_t0(i).unwrap_or(0),
                state.full_get_segment_t1(i).unwrap_or(0),
            );
            out.push(Segment {
                start_ms: t0 * 10,
                end_ms: t1 * 10,
                text,
                lang: self.lang.clone(),
            });
        }
        out
    }
}
