"""
Builds 10 real, human-voiced (not AI-generated) sample audio clips from
Mozilla Common Voice - a crowdsourced speech dataset released under CC0
("no rights reserved" / public domain dedication - contributors
explicitly donate their recordings to the public domain, no attribution
required, free to redistribute). This is genuinely free-and-clear real
human voice data, not a workaround - see
https://commonvoice.mozilla.org and https://creativecommons.org/publicdomain/zero/1.0/

Why this has to be a script you run yourself rather than something done
for you directly: this project's own sandbox can only reach a small
allowlist of package registries (PyPI, npm, GitHub) - not
commonvoice.mozilla.org or huggingface.co, where the actual dataset
lives. This downloads it via Hugging Face's `datasets` library in
streaming mode (pulls only the clips it needs, not the full multi-GB
corpus) using your own normal internet access.

Individual Common Voice clips are usually short (a few seconds - one
spoken sentence each). To meet a 10-second minimum per sample, this
picks several clips from the *same* speaker (so the voice doesn't
suddenly change mid-clip) and concatenates them until that speaker's
combined clips reach 10+ seconds.

Usage:
    pip install datasets soundfile
    python scripts/generate_sample_audio_real_voices.py
"""
import json
import sys
from pathlib import Path

import numpy as np
from pydub import AudioSegment

ROOT_DIR = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT_DIR / "data" / "Audio"
MIN_DURATION_MS = 15_000  # 15 seconds
TARGET_MALE = 5
TARGET_FEMALE = 5

# fsicoli/common_voice_19_0 is an unofficial but CC0-licensed mirror of
# Mozilla Common Voice on Hugging Face - doesn't require the click-
# through agreement Mozilla's own official HF listings sometimes do.
# If this specific dataset version has been taken down or renamed by
# the time you run this, swap in whatever current CC0 Common Voice
# mirror is available - search "common voice" on huggingface.co/datasets
# and check the license shown on the dataset card says CC0 before using it.
DATASET_NAME = "fsicoli/common_voice_19_0"
DATASET_CONFIG = "en"
DATASET_SPLIT = "validated"


def main():
    try:
        from datasets import load_dataset
    except ImportError:
        print("Missing dependency - run: pip install datasets soundfile")
        sys.exit(1)

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Streaming {DATASET_NAME} ({DATASET_CONFIG}/{DATASET_SPLIT}) from Hugging Face...")
    print("(streaming mode - only pulls the clips actually used below, not the full dataset)\n")
    try:
        ds = load_dataset(DATASET_NAME, DATASET_CONFIG, split=DATASET_SPLIT, streaming=True)
    except Exception as e:
        print(f"Could not load the dataset: {e}")
        print("If this dataset has been renamed/removed, search 'common voice' on")
        print("huggingface.co/datasets, confirm the license shown says CC0, and update")
        print("DATASET_NAME/DATASET_CONFIG/DATASET_SPLIT at the top of this script.")
        sys.exit(1)

    # Group incoming clips by speaker (client_id) and gender, accumulating
    # per-speaker audio until it clears the 10s minimum - stops pulling
    # from the stream as soon as both buckets are full.
    speakers = {}  # client_id -> {"gender": ..., "segments": [AudioSegment, ...], "duration_ms": int}
    male_speakers_done = []
    female_speakers_done = []

    def total_needed():
        return (TARGET_MALE - len(male_speakers_done)) + (TARGET_FEMALE - len(female_speakers_done))

    count_seen = 0
    for row in ds:
        count_seen += 1
        if total_needed() <= 0:
            break
        if count_seen > 20000:  # safety cap so this can't run forever
            print("Hit the safety scan limit without finding enough tagged clips - see notes below.")
            break

        gender = (row.get("gender") or "").strip().lower()
        if gender not in ("male", "female"):
            continue
        if gender == "male" and len(male_speakers_done) >= TARGET_MALE:
            continue
        if gender == "female" and len(female_speakers_done) >= TARGET_FEMALE:
            continue

        client_id = row.get("client_id", f"unknown_{count_seen}")
        audio = row.get("audio")
        if not audio or "array" not in audio:
            continue

        samples = (np.array(audio["array"]) * 32767).astype(np.int16)
        seg = AudioSegment(
            samples.tobytes(), frame_rate=audio["sampling_rate"], sample_width=2, channels=1
        )

        entry = speakers.setdefault(client_id, {"gender": gender, "segments": [], "duration_ms": 0})
        entry["segments"].append(seg)
        entry["duration_ms"] += len(seg)

        if entry["duration_ms"] >= MIN_DURATION_MS:
            if gender == "male" and client_id not in male_speakers_done:
                male_speakers_done.append(client_id)
            elif gender == "female" and client_id not in female_speakers_done:
                female_speakers_done.append(client_id)

    print(f"Scanned {count_seen} clips - found {len(male_speakers_done)}/{TARGET_MALE} male, "
          f"{len(female_speakers_done)}/{TARGET_FEMALE} female speakers with 10+ seconds of audio.\n")

    manifest = []
    sample_num = 1
    for gender, client_ids in (("male", male_speakers_done), ("female", female_speakers_done)):
        for client_id in client_ids:
            entry = speakers[client_id]
            combined = sum(entry["segments"][1:], entry["segments"][0])
            combined = combined.set_frame_rate(16000).set_channels(1).set_sample_width(2)

            sample_id = f"sample_{sample_num:02d}_{gender}"
            wav_path = AUDIO_DIR / f"{sample_id}.wav"
            combined.export(wav_path, format="wav")
            duration_s = len(combined) / 1000
            print(f"  -> {wav_path.name} ({duration_s:.1f}s, {gender}, speaker {client_id[:12]}...)")

            manifest.append({
                "id": sample_id,
                "label": f"Common Voice clip {sample_num} ({gender.capitalize()})",
                "gender": gender,
                "file": wav_path.name,
                "url": f"/audio_samples/{wav_path.name}",
            })
            sample_num += 1

    if not manifest:
        print("No usable clips found - the dataset's gender tagging may be too sparse in the")
        print("slice this streamed through, or the dataset config changed. Try increasing the")
        print("safety cap (count_seen > 20000) further up in this script, or pick a different")
        print("Common Voice language/config where more contributors filled in gender.")
        sys.exit(1)

    manifest_path = AUDIO_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone. {len(manifest)} real human-voice samples written to {AUDIO_DIR}")
    print("These replace the previous synthesized (espeak-ng/edge-tts) sample set entirely -")
    print("delete or rename the old sample_XX_*.wav files still sitting in data/Audio/ if you")
    print("want them gone, since this script doesn't remove them automatically.")
    print("Restart the server (or reload the page) to pick up the new samples.")


if __name__ == "__main__":
    main()
