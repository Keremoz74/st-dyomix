# Draws app-icon.png (1024×1024), the source for `tauri icon`, plus the desktop icons in src-tauri/icons.
from PIL import Image, ImageDraw, ImageFilter
import math
S = 2048  # draw at 2x, then downsample for smooth edges
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# background: rounded square with a vertical gradient
bg = Image.new('RGBA', (S, S))
for y in range(S):
    t = y / S
    c = (int(38 - 14 * t), int(40 - 14 * t), int(48 - 16 * t), 255)
    ImageDraw.Draw(bg).line([(0, y), (S, y)], fill=c)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
img.paste(bg, (0, 0), mask)
# waveform bars
n = 13; left = S * 0.17; right = S * 0.83; w = (right - left) / n
heights = [0.18, 0.32, 0.5, 0.36, 0.62, 0.8, 0.95, 0.74, 0.55, 0.68, 0.4, 0.26, 0.16]
cy = S * 0.5
for i, hgt in enumerate(heights):
    t = i / (n - 1)
    col = (int(76 + (255 - 76) * t), int(154 + (159 - 154) * t), int(255 + (67 - 255) * t), 255)  # blue → orange
    x0 = left + i * w + w * 0.18; x1 = left + (i + 1) * w - w * 0.18
    hh = hgt * S * 0.30
    d.rounded_rectangle([x0, cy - hh, x1, cy + hh], radius=(x1 - x0) / 2, fill=col)
# playhead
px = left + 7 * w
d.rounded_rectangle([px - S * 0.008, S * 0.16, px + S * 0.008, S * 0.84], radius=S * 0.008, fill=(255, 255, 255, 235))
d.polygon([(px - S * 0.045, S * 0.13), (px + S * 0.045, S * 0.13), (px, S * 0.19)], fill=(255, 255, 255, 245))
icon = img.resize((1024, 1024), Image.LANCZOS)
icon.save('app-icon.png')
out = 'src-tauri/icons/'
for name, size in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256), ('icon.png', 512)]:
    icon.resize((size, size), Image.LANCZOS).save(out + name)
icon.save(out + 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.save(out + 'icon.icns')
print('icons written')
