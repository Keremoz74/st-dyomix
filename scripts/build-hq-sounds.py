#!/usr/bin/env python3
"""Builds the high-quality Sound Library packs (sounds-hq/*.json) from free multi-sampled libraries.

Sources (via https://github.com/danigb/samples):
  Splendid Grand Piano (Steinway, 4 velocity layers) - Public Domain - sfzinstruments/SplendidGrandPiano
  jRhodes3d (1977 Rhodes Mark I Stage 73, 5 velocity layers) - CC0 - J. Learman
  Double bass pizzicato (3 dynamics) - CC0 - D. Smolken
Usage: build-hq-sounds.py <danigb-samples/audio dir> <out dir>   (needs ffmpeg)
"""
import base64, json, os, re, subprocess, sys

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
PCS = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}

def midi(name):
    m = re.match(r'^([A-Ga-g])([#b]?)(-?\d)$', name)
    pc = PCS[m.group(1).upper()] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)
    return (int(m.group(3)) + 1) * 12 + pc

def enc(path, secs, ch, kbps):
    fade = max(0.2, secs * 0.25)
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-t', str(secs), '-af', f'afade=t=out:st={secs - fade}:d={fade}',
                          '-ac', str(ch), '-ar', '44100', '-b:a', f'{kbps}k', '-f', 'mp3', '-'], capture_output=True, check=True).stdout
    return 'data:audio/mpeg;base64,' + base64.b64encode(out).decode()

def pack(fid, name, credit, layers):
    data = {'name': name, 'credit': credit, 'layers': [{'v': v, 'notes': {str(k): d for k, d in sorted(n.items())}} for v, n in layers]}
    with open(f'{OUT}/{fid}.json', 'w') as f: json.dump(data, f, separators=(',', ':'))
    print(fid, sum(len(n) for _, n in layers), 'samples', os.path.getsize(f'{OUT}/{fid}.json') // 1024, 'KB')

# Grand piano
d = f'{SRC}/splendid-grand-piano'
lay = {'PP': 40, 'Mp': 70, 'Mf': 100, 'FF': 127}
L = {k: {} for k in lay}
for fn in sorted(os.listdir(d)):
    m = re.match(r'^(PP|Mp|Mf|FF)-([A-G]#?\d)\.ogg$', fn)
    if m: L[m.group(1)][midi(m.group(2))] = enc(f'{d}/{fn}', 5, 2, 96)
pack('splendid-grand-piano', 'Grand Piano (Steinway)', 'Splendid Grand Piano, Public Domain (sfzinstruments/SplendidGrandPiano)',
     [(lay[k], L[k]) for k in ['PP', 'Mp', 'Mf', 'FF']])

# Rhodes
d = f'{SRC}/jlearman/rhodes-mki/jRhodes3d-mono'
lay = {1: 30, 2: 55, 3: 80, 4: 105, 5: 127}
L = {k: {} for k in lay}
for fn in sorted(os.listdir(d)):
    m = re.match(r'^A_(\d+)__\w+_(\d)\.ogg$', fn)
    if m: L[int(m.group(2))][int(m.group(1))] = enc(f'{d}/{fn}', 6, 1, 80)
pack('jrhodes', 'Rhodes Mark I', 'jRhodes3d by J. Learman, CC0 1.0', [(lay[k], L[k]) for k in sorted(lay)])

# Upright bass
d = f'{SRC}/dsmolken/double-bass/pizz'
lay = {'p': 50, 'm': 90, 'f': 127}
L = {k: {} for k in lay}
for fn in sorted(os.listdir(d)):
    m = re.match(r'^pizz_([a-g]b?)(\d)_([pmf])a\.ogg$', fn)
    if m: L[m.group(3)][midi(m.group(1).capitalize() + m.group(2))] = enc(f'{d}/{fn}', 4, 1, 80)
pack('upright-bass', 'Upright Bass', 'Double bass by D. Smolken, CC0 1.0', [(lay[k], L[k]) for k in ['p', 'm', 'f']])
