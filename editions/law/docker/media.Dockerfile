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

ARG SERVER_IMAGE=stirrup-law:local
FROM ${SERVER_IMAGE}

USER root

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
  && chown -R node:node /opt/law-venv \
  && npm install --global --ignore-scripts tsx@4.23.15 \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/law-venv/bin:${PATH}"
ENV LAW_MEDIA_TMP=/tmp/law-media

WORKDIR /app

USER node

# Same edition TypeScript source the api/worker image already carries; tsx runs
# the standalone media entry (see editions/law/src/server/media/main.ts).
ENTRYPOINT ["tsx", "editions/law/src/server/media/main.ts"]
CMD []

HEALTHCHECK --interval=60s --timeout=30s --start-period=20s --retries=3 \
  CMD tsx editions/law/src/server/media/main.ts media:doctor
