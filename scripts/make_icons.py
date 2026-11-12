"""Generate REEL-7 app icons (PNG + SVG) in the device's visual language."""
from PIL import Image, ImageDraw, ImageFilter
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)
BONE, BONE_LO, EDGE, INK, ORANGE = (232, 228, 218), (217, 212, 200), (196, 189, 174), (29, 29, 27), (255, 92, 0)
METAL_A, METAL_B = (236, 233, 226), (200, 195, 185)

def draw(size, maskable=False, ss=4):
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BONE)
        scale = 0.58  # keep the reel inside the 80% safe zone
    else:
        r = int(S * 0.22)
        d.rounded_rectangle([0, 0, S - 1, S - 1], r, fill=BONE)
        scale = 0.74
    cx = cy = S / 2
    R = S * scale / 2
    # well
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=EDGE)
    # platter with soft shadow
    pr = R * 0.9
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - pr, cy - pr + S * 0.012, cx + pr, cy + pr + S * 0.012], fill=(40, 34, 20, 110))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * 0.012)))
    d = ImageDraw.Draw(img)
    steps = 60
    for i in range(steps):
        t = i / (steps - 1)
        rr = pr * (1 - t)
        c = tuple(int(METAL_B[k] + (METAL_A[k] - METAL_B[k]) * t) for k in range(3))
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c)
    # grooves
    for k in range(6, 18):
        rr = pr * k / 18
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(0, 0, 0, 14), width=max(1, ss))
    # dimple
    a = math.radians(-60)
    dx, dy = cx + math.cos(a) * pr * 0.62, cy + math.sin(a) * pr * 0.62
    dr = pr * 0.17
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=(186, 181, 170))
    d.ellipse([dx - dr * 0.8, dy - dr * 0.75, dx + dr * 0.8, dy + dr * 0.85], fill=(206, 201, 191))
    # hub
    hr = pr * 0.3
    d.ellipse([cx - hr, cy - hr, cx + hr, cy + hr], fill=INK)
    # orange tick mark on rim = record head
    tw = pr * 0.07
    d.rounded_rectangle([cx - tw / 2, cy - R * 1.0, cx + tw / 2, cy - R * 0.78], radius=tw / 2, fill=ORANGE)
    return img.resize((size, size), Image.LANCZOS)

for s in (48, 96, 144, 192, 512):
    draw(s).save(os.path.join(OUT, f'icon-{s}.png'))
for s in (192, 512):
    draw(s, maskable=True).save(os.path.join(OUT, f'maskable-{s}.png'))
ap = Image.new('RGBA', (180, 180), BONE + (255,))
ap.alpha_composite(draw(180, maskable=True))
ap.convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))

svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><radialGradient id="m" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ece9e2"/><stop offset="1" stop-color="#c8c3b9"/></radialGradient></defs>
  <rect width="512" height="512" rx="112" fill="#e8e4da"/>
  <circle cx="256" cy="256" r="189" fill="#c4bdae"/>
  <circle cx="256" cy="260" r="170" fill="#000" opacity=".12"/>
  <circle cx="256" cy="256" r="170" fill="url(#m)"/>
  <g fill="none" stroke="#000" stroke-opacity=".06" stroke-width="2"><circle cx="256" cy="256" r="140"/><circle cx="256" cy="256" r="115"/><circle cx="256" cy="256" r="90"/></g>
  <circle cx="309" cy="164" r="29" fill="#bab5aa"/><circle cx="309" cy="166" r="23" fill="#cec9bf"/>
  <circle cx="256" cy="256" r="51" fill="#1d1d1b"/>
  <rect x="250" y="67" width="12" height="42" rx="6" fill="#ff5c00"/>
</svg>
'''
open(os.path.join(OUT, 'icon.svg'), 'w').write(svg)
print('icons written to', os.path.abspath(OUT))
