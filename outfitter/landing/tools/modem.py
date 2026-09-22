# Synthesizes a short dial-up modem handshake: dial tone, DTMF, answer tone with phase reversals,
# V.8 CM/JM "bong" (FSK), then V.22bis/V.32-style training (PSK carriers at 1200/2400 Hz with
# scrambled symbols) and the loud scrambled-data hiss. Output: 16-bit mono WAV, 24 kHz.
import math, random, struct, wave
SR = 24000
random.seed(64)
out = []

def tone(freqs, dur, amp=0.3, phase_flip_every=None):
    n = int(SR * dur)
    for i in range(n):
        t = i / SR
        s = 0.0
        for f in freqs:
            ph = 2 * math.pi * f * t
            if phase_flip_every and int(t / phase_flip_every) % 2:
                ph += math.pi
            s += math.sin(ph)
        out.append(amp * s / len(freqs))

def silence(dur, hiss=0.004):
    for _ in range(int(SR * dur)):
        out.append(random.uniform(-hiss, hiss))

def fsk(f0, f1, baud, bits, amp=0.3):
    ph = 0.0
    for b in bits:
        f = f1 if b else f0
        for _ in range(int(SR / baud)):
            ph += 2 * math.pi * f / SR
            out.append(amp * math.sin(ph))

def psk(carrier, baud, dur, amp=0.25, second=None):
    """QPSK-ish: random phase per symbol, optionally summed with a second carrier."""
    n = int(SR * dur); sym = int(SR / baud); ph1 = ph2 = 0.0
    for i in range(n):
        if i % sym == 0:
            ph1 = random.choice([0, 0.5, 1, 1.5]) * math.pi
            ph2 = random.choice([0, 0.5, 1, 1.5]) * math.pi
        t = i / SR
        s = math.sin(2 * math.pi * carrier * t + ph1)
        if second:
            s = 0.6 * s + 0.6 * math.sin(2 * math.pi * second * t + ph2)
        out.append(amp * s)

def fade(start_idx, n, up=True):
    for k in range(n):
        g = k / n if up else 1 - k / n
        out[start_idx + k] *= g

# 1. off-hook dial tone (US precise dial tone 350+440 Hz)
a = len(out); tone([350, 440], 0.45, 0.25); fade(a, 240); fade(len(out) - 240, 240, False)
silence(0.08)
# 2. DTMF: dial 5 digits, 75 ms each, 55 ms gaps
DTMF = {'1': (697, 1209), '2': (697, 1336), '5': (770, 1336), '6': (770, 1477), '4': (770, 1209), '9': (852, 1477)}
for d in "64915":
    a = len(out); tone(DTMF[d], 0.075, 0.3); fade(a, 60); fade(len(out) - 60, 60, False)
    silence(0.055)
silence(0.25)
# 3. answer tone: 2100 Hz with 450 ms phase reversals (ANSam-ish), shortened
a = len(out); tone([2100], 0.7, 0.28, phase_flip_every=0.45); fade(a, 120); fade(len(out) - 120, 120, False)
silence(0.06)
# 4. V.8 CM / JM exchange: V.21 FSK (980/1180 and 1650/1850 Hz) -- the "bong-bong" warble
bits = [random.randint(0, 1) for _ in range(90)]
fsk(1650, 1850, 300, bits[:45], 0.26)
fsk(980, 1180, 300, bits[45:], 0.26)
silence(0.05)
# 5. training: the screech -- 1200 Hz then both carriers, symbol rate 600 baud
psk(1200, 600, 0.35, 0.22)
psk(2400, 600, 0.25, 0.22)
psk(1800, 2400, 0.45, 0.26, second=1200)
# 6. scrambled data: broadband hiss that fades to a connected line
a = len(out)
n = int(SR * 0.55)
for i in range(n):
    out.append(random.uniform(-0.35, 0.35) * (1 - i / n) ** 1.5)
silence(0.12, 0.002)

with wave.open("modem.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32000)) for s in out))
print(f"{len(out) / SR:.2f}s")
