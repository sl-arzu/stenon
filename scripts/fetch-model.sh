#!/bin/sh
# Scarica un modello Whisper.cpp in formato ggml.
# Uso: ./scripts/fetch-model.sh [nome-modello]
# Modelli: tiny, base, small, medium, large-v3 (con suffisso -it per l'italiano... no,
# la lingua si imposta a runtime; scaricare il modello multilingue desiderato).
set -e

MODEL="${1:-base-it}"
DIR="${HOME}/.local/share/stenon/models"
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

mkdir -p "$DIR"
case "$MODEL" in
  tiny|base|small|medium|large-v3|large-v3-turbo)
    FILE="ggml-${MODEL}.bin"
    ;;
  tiny-it|base-it|small-it|medium-it)
    FILE="ggml-${MODEL}.bin"
    ;;
  *)
    echo "Modello non riconosciuto: $MODEL" >&2
    exit 1
    ;;
esac

echo "Scarico ${FILE} in ${DIR}..."
curl -L --fail -o "${DIR}/${FILE}" "${BASE_URL}/${FILE}"
echo "Fatto: ${DIR}/${FILE}"
