#!/bin/sh
# Scarica un modello Whisper.cpp in formato ggml.
# Uso: ./scripts/fetch-model.sh [nome-modello]
# Modelli: tiny, base, small, medium, large-v3 (multilingue; la lingua si
# imposta a runtime via config.toml). I modelli *.en sono solo inglese.
set -e

MODEL="${1:-base}"
DIR="${HOME}/.local/share/stenon/models"
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

case "$MODEL" in
  tiny|base|small|medium|large-v3|large-v3-turbo|tiny.en|base.en|small.en)
    FILE="ggml-${MODEL}.bin"
    ;;
  *)
    echo "Modello non riconosciuto: $MODEL" >&2
    echo "Disponibili: tiny, base, small, medium, large-v3, large-v3-turbo (+ .en)" >&2
    exit 1
    ;;
esac

mkdir -p "$DIR"
echo "Scarico ${FILE} in ${DIR}..."
curl -L --fail -o "${DIR}/${FILE}" "${BASE_URL}/${FILE}"
echo "Fatto: ${DIR}/${FILE}"
