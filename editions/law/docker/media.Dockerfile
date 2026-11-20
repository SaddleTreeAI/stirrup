# Law processing sidecar: heavy tools around the law server image.
# Build (after a local law server image exists):
#   docker build -f editions/law/docker/media.Dockerfile \
#     --build-arg SERVER_IMAGE=stirrup-law:local \
#     -t stirrup-law-media:local .
#
# Apt packages are pinned by Debian bookworm release, not by hash.
# Licenses (run as separate processes; not linked into Stirrup):
#   ffmpeg     — GPL (Debian build) / LGPL upstream depending on configure
#   poppler-utils (pdftotext) — GPL
#   tesseract-ocr / tesseract-ocr-eng — Apache-2.0
#   ocrmypdf — MPL-2.0
#   python3 — PSF
#   faster-whisper 1.2.1 — MIT (CTranslate2 MIT; Whisper weights MIT)
#
# GPU variant (not built here): FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04
# as the base for a CUDA image, then layer the law server bits; faster-whisper
# 1.2.1 + current ctranslate2 need CUDA 12 + cuDNN 9. Uncomment the GPU block
# in editions/law/docker/compose.media.yml on NVIDIA hosts.

ARG SERVER_IMAGE=stirrup-law:local
FROM ${SERVER_IMAGE}

USER root

# WITH_ASR=1 (default) installs pinned faster-whisper into /opt/law-venv.
ARG WITH_ASR=1
# Pin after reading faster-whisper 1.2.1 release notes (CUDA 12 + cuDNN 9).
ARG FASTER_WHISPER_VERSION=1.2.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    ocrmypdf \
    python3 \
    python3-venv \
  && python3 -m venv /opt/law-venv \
  && if [ "$WITH_ASR" = "1" ]; then \
       /opt/law-venv/bin/pip install --no-cache-dir "faster-whisper==${FASTER_WHISPER_VERSION}"; \
     fi \
  && chown -R node:node /opt/law-venv \
  && npm install --global --ignore-scripts tsx@4.23.15 \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY editions/law/media-tools/asr.py /opt/law-media-tools/asr.py
RUN chown node:node /opt/law-media-tools/asr.py

ENV PATH="/opt/law-venv/bin:${PATH}"
ENV LAW_MEDIA_TMP=/tmp/law-media
ENV LAW_MODELS_DIR=/models
ENV LAW_ASR_SCRIPT=/opt/law-media-tools/asr.py
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

WORKDIR /app

USER node

# Same edition TypeScript source the api/worker image already carries; tsx runs
# the standalone media entry (see editions/law/src/server/media/main.ts).
ENTRYPOINT ["tsx", "editions/law/src/server/media/main.ts"]
CMD []

HEALTHCHECK --interval=60s --timeout=30s --start-period=20s --retries=3 \
  CMD tsx editions/law/src/server/media/main.ts media:doctor
