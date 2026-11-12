//! Cattura audio dal microfono (cpal) e utilità di conversione.

pub mod capture;

pub use capture::{start_capture, to_mono_16k, Capture};
