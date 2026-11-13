//! Implementazione Whisper (whisper-rs) del trait `Transcriber`.

use super::{Segment, Transcriber};
use std::path::Path;
use whisper_rs::{
    get_lang_str, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

/// Trascrizione locale con whisper.cpp.
pub struct WhisperTranscriber {
    ctx: WhisperContext,
    lang: String,
    initial_prompt: String,
}

impl WhisperTranscriber {
    /// Carica il modello ggml da `model_path`.
    pub fn new(model_path: &Path, language: &str) -> Result<Self, whisper_rs::WhisperError> {
        Self::with_prompt(model_path, language, "")
    }

    /// Come [`new`], con vocabolario personalizzato (nomi propri, termini tecnici)
    /// passato come prompt iniziale al modello.
    pub fn with_prompt(
        model_path: &Path,
        language: &str,
        initial_prompt: &str,
    ) -> Result<Self, whisper_rs::WhisperError> {
        let path_str = model_path.to_str().ok_or_else(|| {
            eprintln!("stenon: percorso modello non valido UTF-8");
            whisper_rs::WhisperError::GenericError(-1)
        })?;
        let ctx = WhisperContext::new_with_params(path_str, WhisperContextParameters::default())?;
        Ok(Self {
            ctx,
            lang: language.to_string(),
            initial_prompt: initial_prompt.to_string(),
        })
    }

    pub fn language(&self) -> &str {
        &self.lang
    }

    /// Cambia la lingua di trascrizione a runtime ("auto" = rilevamento).
    pub fn set_language(&mut self, language: &str) {
        self.lang = language.to_string();
    }

    /// Una singola passata di trascrizione con la lingua indicata.
    /// Restituisce segmenti, probabilità media dei token e id lingua rilevato.
    fn run_pass(&self, pcm: &[f32], lang: &str) -> Option<(Vec<Segment>, f32, Option<i32>)> {
        let mut state = self.ctx.create_state().ok()?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        let _ = params.set_language(Some(lang));
        if !self.initial_prompt.is_empty() {
            params.set_initial_prompt(&self.initial_prompt);
        }
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        if let Err(e) = state.full(params, pcm) {
            eprintln!("whisper: trascrizione fallita ({lang}): {e}");
            return None;
        }

        let detected = state.full_lang_id_from_state().ok();
        let n = state.full_n_segments().ok()?;
        let mut out = Vec::with_capacity(n as usize);
        let mut prob_sum = 0.0f32;
        let mut prob_n = 0i64;
        for i in 0..n {
            let text = match state.full_get_segment_text(i) {
                Ok(t) => t.trim().to_string(),
                Err(_) => continue,
            };
            if let Ok(nt) = state.full_n_tokens(i) {
                for j in 0..nt {
                    if let Ok(td) = state.full_get_token_data(i, j) {
                        prob_sum += td.p;
                        prob_n += 1;
                    }
                }
            }
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
                lang: lang.to_string(),
            });
        }
        let avg_prob = if prob_n > 0 {
            prob_sum / prob_n as f32
        } else {
            0.0
        };
        Some((out, avg_prob, detected))
    }

    /// Trascrive rispettando l'insieme di lingue ammesse.
    /// - `allowed` vuoto: rilevamento libero tra tutte le lingue.
    /// - una sola lingua: fissata, nessun rilevamento, passata unica.
    /// - più lingue (o libere): l'audio è diviso in blocchi da ~10 s e ogni
    ///   blocco è trascritto con la propria lingua — così una dettatura che
    ///   mescola due lingue esce con le due lingue giuste. Se la lingua
    ///   rilevata di un blocco non è ammessa, il blocco viene ritrascritto
    ///   con ciascuna lingua ammessa tenendo la più probabile.
    /// Restituisce i segmenti e la lingua dominante effettivamente usata.
    pub fn transcribe_constrained(
        &mut self,
        pcm: &[f32],
        allowed: &[String],
    ) -> (Vec<Segment>, String) {
        if pcm.is_empty() {
            return (Vec::new(), self.lang.clone());
        }
        if allowed.len() == 1 {
            self.lang = allowed[0].clone();
            let segs = self
                .run_pass(pcm, &allowed[0])
                .map(|(s, _, _)| s)
                .unwrap_or_default();
            return (segs, allowed[0].clone());
        }

        // Blocchi da 5 s con confini nei punti di silenzio: in whisper la
        // lingua si rileva una sola volta per passata, quindi per l'alternanza
        // di lingue (anche in dettature brevi) serve ridividere spesso.
        let chunks = split_at_silence(pcm, 80_000); // 5 s a 16 kHz
        let mut all: Vec<Segment> = Vec::new();
        let mut lang_score: Vec<(String, usize)> = Vec::new(); // (lingua, caratteri)

        for (start, end) in chunks {
            let offset_ms = (start * 1000 / 16_000) as i64;
            let chunk = trim_silence_edges(&pcm[start..end]);
            if chunk.is_empty() {
                continue;
            }
            let (segs, _used) = self.transcribe_chunk(chunk, allowed);
            for mut s in segs {
                s.start_ms += offset_ms;
                s.end_ms += offset_ms;
                if !s.text.is_empty() {
                    let key = s.lang.to_uppercase();
                    match lang_score.iter_mut().find(|(l, _)| *l == key) {
                        Some(e) => e.1 += s.text.len(),
                        None => lang_score.push((key, s.text.len())),
                    }
                }
                all.push(s);
            }
        }

        // lingua dominante = quella con più caratteri trascritti
        lang_score.sort_by(|a, b| b.1.cmp(&a.1));
        let dominant = lang_score
            .first()
            .map(|(l, _)| l.clone())
            .unwrap_or_else(|| self.lang.clone());
        (all, dominant)
    }

    /// Trascrive un blocco: auto prima, poi ritenti sulle lingue ammesse.
    fn transcribe_chunk(&mut self, pcm: &[f32], allowed: &[String]) -> (Vec<Segment>, String) {
        let auto = self.run_pass(pcm, "auto");
        let detected = auto
            .as_ref()
            .and_then(|(_, _, id)| *id)
            .and_then(|id| get_lang_str(id).map(|s| s.to_string()));

        let accepted = match (&detected, &auto) {
            // nessun vincolo: la passata libera va sempre bene
            _ if allowed.is_empty() => true,
            // lingua rilevata e ammessa: accetta
            (Some(d), Some(_)) => allowed.iter().any(|l| l == d),
            // rilevamento mancante: non è affidabile, riprova con le ammesse
            _ => false,
        };

        if accepted {
            if let Some((segs, _, _)) = auto {
                let used = detected.unwrap_or_else(|| "auto".to_string());
                return (segs, used);
            }
        }

        // Lingua rilevata non ammessa (o rilevamento mancante):
        // una passata per ogni lingua ammessa, vince la più sicura.
        let mut best: Option<(Vec<Segment>, f32, String)> = None;
        for lang in allowed {
            if let Some((segs, prob, _)) = self.run_pass(pcm, lang) {
                let better = best.as_ref().map(|(_, bp, _)| prob > *bp).unwrap_or(true);
                if better {
                    best = Some((segs, prob, lang.clone()));
                }
            }
        }
        match best {
            Some((segs, _, lang)) => (segs, lang),
            None => (Vec::new(), self.lang.clone()),
        }
    }
}

/// Divide l'audio in blocchi di durata circa `target` campioni, spostando
/// ogni confine nel punto più silenzioso nelle vicinanze (±1 s) per non
/// troncare le parole a metà.
fn split_at_silence(pcm: &[f32], target: usize) -> Vec<(usize, usize)> {
    const SEARCH: usize = 16_000; // ±1 s
    const WIN: usize = 480; // 30 ms
    let energy = |i: usize| -> f32 {
        pcm[i..(i + WIN).min(pcm.len())]
            .iter()
            .map(|s| s.abs())
            .sum()
    };
    let mut bounds = vec![0usize];
    let mut b = target;
    while b < pcm.len() {
        let lo = b.saturating_sub(SEARCH);
        let hi = (b + SEARCH).min(pcm.len().saturating_sub(WIN));
        if hi <= lo {
            break;
        }
        let best = (lo..hi)
            .step_by(80)
            .min_by(|x, y| energy(*x).partial_cmp(&energy(*y)).unwrap())
            .unwrap();
        bounds.push(best);
        b = best + target;
    }
    bounds.push(pcm.len());
    bounds
        .windows(2)
        .filter(|w| w[1] > w[0])
        .map(|w| (w[0], w[1]))
        .collect()
}

/// Taglia il silenzio iniziale e finale (soglia bassa, finestra di 50 ms):
/// blocchi più puliti migliorano il rilevamento della lingua.
fn trim_silence_edges(pcm: &[f32]) -> &[f32] {
    const THRESHOLD: f32 = 0.002;
    const WIN: usize = 800; // 50 ms a 16 kHz
    let loud = |w: &[f32]| w.iter().any(|s| s.abs() > THRESHOLD);
    let start = (0..pcm.len().saturating_sub(WIN))
        .step_by(WIN)
        .find(|&i| loud(&pcm[i..i + WIN]))
        .unwrap_or(0);
    let end = (start..pcm.len())
        .rev()
        .step_by(WIN)
        .find(|&i| i + WIN <= pcm.len() && loud(&pcm[i..i + WIN]))
        .map(|i| i + WIN)
        .unwrap_or(pcm.len());
    &pcm[start..end.max(start)]
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
        if !self.initial_prompt.is_empty() {
            params.set_initial_prompt(&self.initial_prompt);
        }
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
