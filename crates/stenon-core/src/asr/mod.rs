//! Trait ASR e segmenti di trascrizione.

#[derive(Debug, Clone)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub lang: String,
}

/// Motore di trascrizione locale.
pub trait Transcriber: Send + Sync {
    /// Trascrive PCM mono f32 a 16 kHz in segmenti timestampati.
    fn transcribe(&self, pcm: &[f32]) -> Vec<Segment>;
}

#[cfg(feature = "whisper")]
pub mod whisper;

#[cfg(feature = "whisper")]
pub use whisper::WhisperTranscriber;

// Taglio silenzio ai bordi dei blocchi (usato anche dalla riunione, Fase C)
#[cfg(feature = "whisper")]
pub use whisper::trim_silence_edges;
