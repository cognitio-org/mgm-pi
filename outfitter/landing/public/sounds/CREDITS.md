# Sound credits

Short excerpts (trimmed, mixed to mono, high-passed at 60 Hz, peak-normalized) from two
freesound_community recordings on Pixabay, distributed under the Pixabay Content License:
https://pixabay.com/service/license-summary/

- "Floppy drive on old PC" (Pixabay item 52014)
- "Reading floppy disc 2" (Pixabay item 35303)

launch.mp3: 52014 at 125.15-127.45 s (head seek) + 35303 at 1.0-3.4 s (reading, +12 dB)
load.mp3: 52014 at 151.55-151.97 s + 153.05-153.95 s (seeks)

modem.mp3 is synthesized (no recording): `outfitter/landing/tools/modem.py` writes the WAV, then
ffmpeg band-limits it to a phone line and encodes it:
`ffmpeg -i modem.wav -af "highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=3" …`,
peak-normalized to -3 dBFS, mono 24 kHz 64 kb/s MP3.
