"""
Regenerates the 10 bundled sample audio clips in data/Audio/ using
Microsoft Edge's free neural text-to-speech voices (via the open-source
`edge-tts` package) instead of the robotic espeak-ng voice they were
originally created with.

Why this is a separate, manually-run script rather than something
app.cmd does automatically: it needs to reach a Microsoft speech
service over the network, which isn't guaranteed available on every
machine/network (corporate proxies, offline use, etc.) - the app itself
should keep working without it. Run this once, whenever you want to
regenerate the samples; the app just uses whatever's already sitting in
data/Audio/.

Usage:
    python scripts/generate_sample_audio.py

Requires: edge-tts (already in requirements.txt), and normal internet
access to Microsoft's TTS endpoint (speech.platform.bing.com) - not
something every network allows, so if this fails to connect, that's
almost certainly why.
"""
import asyncio
import json
import sys
from pathlib import Path

import edge_tts
from pydub import AudioSegment

ROOT_DIR = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT_DIR / "data" / "Audio"

# 5 real male + 5 real female Microsoft neural voices (verified current
# voice names, not guessed) - genuinely natural-sounding neural TTS, not
# the formant-synthesis robotic voice the samples originally used.
# Text lengths below are the same ones empirically verified (not just
# estimated) to clear 15+ seconds via espeak-ng at a measured pace -
# an earlier version of this file estimated duration from word count
# (~2.3 words/sec) and was wrong by roughly 2x for espeak-ng's actual
# rate, shipping ~4-5s clips instead of the intended ~15s. Edge TTS's
# neural voices tend to pace closer to natural conversational speech
# than espeak-ng did, so these should comfortably clear 15s here too,
# but there's no way to verify that from this sandbox (no network
# access to Microsoft's TTS service) - check the actual output
# duration after running this, and lengthen further if needed.
SAMPLES = [
    {
        "id": "sample_01_greeting",
        "label": "Greeting (Male)",
        "gender": "male",
        "voice": "en-US-GuyNeural",
        "text": (
            "Hello there, and welcome. I'm really glad you decided to try this "
            "out today. Whether you're testing the avatar system or just "
            "exploring what it can do, I hope you enjoy the experience and "
            "everything works exactly the way you'd expect it to."
        ),
    },
    {
        "id": "sample_02_morning",
        "label": "Good Morning (Female)",
        "gender": "female",
        "voice": "en-US-JennyNeural",
        "text": (
            "Good morning! I hope you slept well and you're ready for a great "
            "day ahead. The sun is coming up, there's a fresh pot of coffee "
            "waiting, and there's plenty of time to get everything done "
            "before the day really gets going."
        ),
    },
    {
        "id": "sample_03_pangram",
        "label": "Pangram (Male)",
        "gender": "male",
        "voice": "en-US-ChristopherNeural",
        "text": (
            "The quick brown fox jumps over the lazy dog, again and again, "
            "near the old riverbank at sunset. It's a strange little "
            "sentence, but it happens to use every single letter of the "
            "alphabet at least once, which is the whole point of a sentence "
            "like this."
        ),
    },
    {
        "id": "sample_04_welcome",
        "label": "Welcome Message (Female)",
        "gender": "female",
        "voice": "en-US-AriaNeural",
        "text": (
            "Welcome to this demonstration of the instant three dee avatar "
            "system. You're about to see how quickly a model can load and "
            "start speaking, all without waiting on any heavy generation "
            "process running in the background, which is really the whole "
            "point of building it this way."
        ),
    },
    {
        "id": "sample_05_technology",
        "label": "About Technology (Male)",
        "gender": "male",
        "voice": "en-US-EricNeural",
        "text": (
            "Technology has completely changed the way people communicate "
            "with each other, connect with old friends, and even meet new "
            "ones. Every single year it seems to move a little faster than "
            "the year before it, and it can be hard to keep up with all "
            "of it."
        ),
    },
    {
        "id": "sample_06_seashells",
        "label": "Seashells Tongue-Twister (Female)",
        "gender": "female",
        "voice": "en-US-MichelleNeural",
        "text": (
            "She sells seashells by the seashore, every single summer "
            "morning, rain or shine. It's one of those old tongue twisters "
            "that gets harder to say correctly the faster you try to say it "
            "out loud, which is exactly why people still enjoy trying it "
            "today."
        ),
    },
    {
        "id": "sample_07_instructions",
        "label": "App Instructions (Male)",
        "gender": "male",
        "voice": "en-US-RogerNeural",
        "text": (
            "Please take a moment to select an avatar from the list, then "
            "choose your audio file, and press the play button when you're "
            "ready. The whole process should only take a few seconds from "
            "start to finish, so there's really no need to rush through "
            "any of it."
        ),
    },
    {
        "id": "sample_08_ai",
        "label": "About AI (Female)",
        "gender": "female",
        "voice": "en-GB-SoniaNeural",
        "text": (
            "Artificial intelligence is transforming entire industries all "
            "around the world, from healthcare and education to "
            "transportation and entertainment. It's honestly hard to find a "
            "single field these days that hasn't been touched by it in some "
            "meaningful way, big or small."
        ),
    },
    {
        "id": "sample_09_thanks",
        "label": "Thank You (Male)",
        "gender": "male",
        "voice": "en-GB-RyanNeural",
        "text": (
            "Thank you so much for taking the time to try out this "
            "application today. I really do hope you enjoy using it, and "
            "that it turns out to be genuinely useful for whatever you're "
            "working on, now and further down the road as well."
        ),
    },
    {
        "id": "sample_10_weather",
        "label": "Weather Report (Female)",
        "gender": "female",
        "voice": "en-GB-LibbyNeural",
        "text": (
            "The weather today is looking bright and sunny, with just a "
            "gentle breeze coming in from the west. It should be a really "
            "lovely afternoon to get outside, if you get the chance to "
            "enjoy it."
        ),
    },
]


async def generate_one(sample: dict, tmp_dir: Path) -> Path:
    mp3_path = tmp_dir / f"{sample['id']}.mp3"
    communicate = edge_tts.Communicate(sample["text"], sample["voice"])
    await communicate.save(str(mp3_path))
    return mp3_path


async def generate_all_samples(progress_callback=None) -> list:
    """Generates all 10 samples via edge-tts, overwriting the existing
    sample_XX_*.wav files in place, and rewrites manifest.json. Returns
    the new manifest list. Raises RuntimeError on failure (never calls
    sys.exit - this needs to be safe to import and call from server.py's
    in-app "regenerate" button, where exiting the process would take the
    whole server down with it, not just this operation).

    progress_callback(current, total, sample_label), if given, is called
    before each sample starts generating - lets a caller (like an API
    endpoint) report progress without this function needing to know
    anything about how that's surfaced.
    """
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = AUDIO_DIR / "_tmp_generation"
    tmp_dir.mkdir(exist_ok=True)

    manifest = []
    try:
        for i, sample in enumerate(SAMPLES, 1):
            if progress_callback:
                progress_callback(i, len(SAMPLES), sample["label"])
            try:
                mp3_path = await generate_one(sample, tmp_dir)
            except Exception as e:
                raise RuntimeError(
                    f"Failed generating '{sample['label']}': {e}. This usually means the "
                    "network couldn't reach Microsoft's TTS service (speech.platform.bing.com) "
                    "- check your internet connection, or a firewall/proxy may be blocking it."
                ) from e

            # Normalize to 16kHz mono WAV, matching what the rest of this
            # project expects (same format the bundled sample audio uses).
            wav_path = AUDIO_DIR / f"{sample['id']}.wav"
            audio = AudioSegment.from_file(mp3_path)
            audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
            audio.export(wav_path, format="wav")

            manifest.append({
                "id": sample["id"],
                "label": sample["label"],
                "gender": sample["gender"],
                "file": wav_path.name,
                "url": f"/audio_samples/{wav_path.name}",
                "duration_s": round(len(audio) / 1000, 1),
            })
    finally:
        for f in tmp_dir.glob("*.mp3"):
            f.unlink()
        if tmp_dir.exists():
            tmp_dir.rmdir()

    manifest_path = AUDIO_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    return manifest


async def main():
    print(f"Generating {len(SAMPLES)} sample clips via Microsoft neural TTS...\n")

    def _print_progress(i, total, label):
        print(f"[{i}/{total}] {label}...")

    try:
        manifest = await generate_all_samples(progress_callback=_print_progress)
    except RuntimeError as e:
        print(f"\n{e}")
        sys.exit(1)

    for entry in manifest:
        print(f"  -> {entry['file']} ({entry['duration_s']}s)")
    print(f"\nDone. {len(manifest)} samples written to {AUDIO_DIR}")
    print("Restart the server (or just reload the page) to pick them up.")


if __name__ == "__main__":
    asyncio.run(main())
