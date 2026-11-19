#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 SaddleTree AI
"""Offline ASR: WAV → JSONL segments. No network (expects HF_HUB_OFFLINE=1).

Writes one JSON object per line:
  {"start": s, "end": s, "text": "..."}
and a final:
  {"done": true, "language": "en", "duration": s}

Progress lines on stdout: "progress <0-100>"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def progress(pct: int) -> None:
    pct = max(0, min(100, int(pct)))
    print(f"progress {pct}", flush=True)


def run_faster_whisper(
    wav: Path,
    out: Path,
    model_dir: Path,
    device: str,
    compute_type: str,
    language: str | None,
) -> None:
    # Import only when selected so whisper-cpp hosts need not install it.
    from faster_whisper import WhisperModel  # type: ignore

    if not model_dir.is_dir():
        print("Run media:models once", file=sys.stderr)
        sys.exit(2)

    progress(1)
    model = WhisperModel(
        str(model_dir),
        device=device,
        compute_type=compute_type,
    )
    progress(5)

    lang = None if not language or language == "auto" else language
    segments_iter, info = model.transcribe(
        str(wav),
        language=lang,
        vad_filter=True,
        condition_on_previous_text=False,
        beam_size=5,
        word_timestamps=False,
    )

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    detected = getattr(info, "language", None) or (lang or "en")

    with out.open("w", encoding="utf-8") as fh:
        last_pct = 5
        for segment in segments_iter:
            start = float(segment.start)
            end = float(segment.end)
            text = (segment.text or "").strip()
            fh.write(json.dumps({"start": start, "end": end, "text": text}, ensure_ascii=False))
            fh.write("\n")
            if duration > 0:
                pct = 5 + int(90 * min(1.0, end / duration))
            else:
                pct = min(95, last_pct + 1)
            if pct > last_pct:
                progress(pct)
                last_pct = pct
        fh.write(
            json.dumps(
                {"done": True, "language": detected, "duration": duration},
                ensure_ascii=False,
            )
        )
        fh.write("\n")
    progress(100)


def run_whisper_cpp(
    wav: Path,
    out: Path,
    model_dir: Path,
    language: str | None,
) -> None:
    """Invoke whisper-cli if present; same JSONL contract.

    Expects a ggml model file under model_dir (e.g. ggml-small.bin) and
    `whisper-cli` on PATH. Operators who did not build whisper.cpp get a
    clear error — V1's default engine is faster-whisper.
    """
    import re
    import shutil
    import subprocess

    binary = shutil.which("whisper-cli") or shutil.which("whisper-cpp")
    if not binary:
        print("whisper-cli not found on PATH", file=sys.stderr)
        sys.exit(2)

    model_file = None
    if model_dir.is_file():
        model_file = model_dir
    elif model_dir.is_dir():
        for candidate in sorted(model_dir.glob("ggml*.bin")):
            model_file = candidate
            break
    if model_file is None:
        print("Run media:models once", file=sys.stderr)
        sys.exit(2)

    progress(1)
    # whisper.cpp JSON output (argv only — never shell).
    json_out = out.with_suffix(".whisper.json")
    cmd = [
        binary,
        "-m",
        str(model_file),
        "-f",
        str(wav),
        "-oj",
        "-of",
        str(json_out.with_suffix("")),  # whisper-cli appends .json
    ]
    lang = None if not language or language == "auto" else language
    if lang:
        cmd.extend(["-l", lang])

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(proc.stderr or "whisper-cpp failed", file=sys.stderr)
        sys.exit(proc.returncode or 1)

    progress(80)
    payload = json.loads(json_out.read_text(encoding="utf-8"))
    # whisper.cpp JSON shape: { "transcription": [ { "offsets": {"from": ms, "to": ms}, "text": "..." } ] }
    entries = payload.get("transcription") or payload.get("segments") or []
    duration_ms = 0
    with out.open("w", encoding="utf-8") as fh:
        for entry in entries:
            offsets = entry.get("offsets") or {}
            start_ms = int(offsets.get("from", entry.get("start", 0)) or 0)
            end_ms = int(offsets.get("to", entry.get("end", 0)) or 0)
            # Some builds store seconds as floats under start/end.
            if "start" in entry and isinstance(entry["start"], float):
                start_ms = int(entry["start"] * 1000)
            if "end" in entry and isinstance(entry["end"], float):
                end_ms = int(entry["end"] * 1000)
            text = (entry.get("text") or "").strip()
            # Strip [00:00:00.000 --> ...] prefixes some builds leave in.
            text = re.sub(r"^\[[^\]]+\]\s*", "", text).strip()
            fh.write(
                json.dumps(
                    {"start": start_ms / 1000.0, "end": end_ms / 1000.0, "text": text},
                    ensure_ascii=False,
                )
            )
            fh.write("\n")
            duration_ms = max(duration_ms, end_ms)
        fh.write(
            json.dumps(
                {
                    "done": True,
                    "language": lang or "en",
                    "duration": duration_ms / 1000.0,
                },
                ensure_ascii=False,
            )
        )
        fh.write("\n")
    progress(100)


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline ASR to JSONL")
    parser.add_argument("--wav", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="auto")
    parser.add_argument(
        "--engine",
        default=os.environ.get("LAW_ASR_ENGINE", "faster-whisper"),
        choices=("faster-whisper", "whisper-cpp"),
    )
    args = parser.parse_args()

    wav = Path(args.wav)
    out = Path(args.out)
    model_dir = Path(args.model_dir)
    if not wav.is_file():
        print("audio missing", file=sys.stderr)
        sys.exit(1)

    # Never download at runtime.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    if args.engine == "whisper-cpp":
        run_whisper_cpp(wav, out, model_dir, args.language)
    else:
        run_faster_whisper(
            wav,
            out,
            model_dir,
            args.device,
            args.compute_type,
            args.language,
        )


if __name__ == "__main__":
    main()
