//! Scrittura file WAV PCM16 (per salvataggio audio riunioni, D7).
//! Zero dipendenze: header WAV a 44 byte + dati little-endian.

use std::error::Error;
use std::fs::File;
use std::io::Write;
use std::path::Path;

/// Scrive un file WAV PCM16 mono dal PCM f32 già a 16 kHz.
pub fn write_wav_16k_mono(path: &Path, pcm: &[f32]) -> Result<(), Box<dyn Error>> {
    let mut f = File::create(path)?;
    let data_len = (pcm.len() * 2) as u32;
    // Header WAV: RIFF, fmt (PCM 16 bit mono), data
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16_u32.to_le_bytes())?; // dimensione blocco fmt
    f.write_all(&1_u16.to_le_bytes())?; // PCM
    f.write_all(&1_u16.to_le_bytes())?; // canali: mono
    f.write_all(&16_000_u32.to_le_bytes())?; // sample rate
    f.write_all(&32_000_u32.to_le_bytes())?; // byte rate = rate * ch * 2
    f.write_all(&2_u16.to_le_bytes())?; // block align
    f.write_all(&16_u16.to_le_bytes())?; // bits per sample
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for &s in pcm {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * 32_767.0) as i16;
        f.write_all(&v.to_le_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_valid_wav_header() {
        let dir = std::env::temp_dir().join("stenon-wav-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.wav");
        write_wav_16k_mono(&path, &[0.0, 0.5, -0.5, 1.0]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(&bytes[36..40], b"data");
        // 4 campioni * 2 byte
        assert_eq!(u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]), 8);
        std::fs::remove_file(&path).ok();
    }
}
