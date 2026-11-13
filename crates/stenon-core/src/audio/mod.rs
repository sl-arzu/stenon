//! Cattura audio dal microfono (cpal) e utilità di conversione.

pub mod capture;
// Loopback audio di sistema via ScreenCaptureKit (solo macOS, Fase C)
#[cfg(target_os = "macos")]
pub mod loopback;
// Scrittura file WAV (pcm16 mono 16 kHz) per salvataggio audio riunioni
pub mod wav;

pub use capture::{start_capture, to_mono_16k, Capture};
