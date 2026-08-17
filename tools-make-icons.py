from PIL import Image, ImageDraw
import os
Image.MAX_IMAGE_PIXELS = None

OUT = os.path.expanduser("~/run-navi/icons")
os.makedirs(OUT, exist_ok=True)

BRAND   = (0x75, 0x80, 0x85)     # mark colour sampled from the official logo
BG_TOP  = (0x18, 0x1a, 0x1d)     # near-black card, with a touch of depth
BG_BOT  = (0x08, 0x09, 0x0b)

# --- clean, high-res alpha mask of the mark ---
src = Image.open('mark_hi.png').convert('L')
# The logo is embedded in the PDF as a low-res raster: its edges blur over
# 6-11 px. Hard-thresholding quantises that blur into visible stair-steps, so
# instead tighten the ramp with a steep contrast curve and let LANCZOS supply
# clean anti-aliasing on the way down to icon size.
LO, HI = 45, 92
mask = src.point(lambda v: 0 if v <= LO else (255 if v >= HI else int(255 * (v - LO) / (HI - LO))))

def bg(size):
    g = Image.new('RGB', (1, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))
    return g.resize((size, size))

def mark_layer(box_w, colour=None):
    w = box_w
    h = int(round(w * mask.height / mask.width))
    m = mask.resize((w, h), Image.LANCZOS)
    layer = Image.new('RGBA', (w, h), (colour or BRAND) + (0,))
    layer.putalpha(m)
    return layer

def icon(size, frac=0.60, rounded=True, maskable=False, colour=None):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    im.paste(bg(size), (0, 0))
    if rounded and not maskable:
        r = Image.new('L', (size, size), 0)
        ImageDraw.Draw(r).rounded_rectangle([0, 0, size - 1, size - 1],
                                            radius=int(size * 0.225), fill=255)
        im.putalpha(r)
    lay = mark_layer(int(size * frac), colour)
    im.alpha_composite(lay, ((size - lay.width) // 2, int((size - lay.height) / 2)))
    return im

for s in (180, 192, 512):
    icon(s).save(f"{OUT}/icon-{s}.png")
icon(512, frac=0.46, maskable=True).save(f"{OUT}/icon-maskable-512.png")

# A browser tab is ~16 px tall: the brand grey goes muddy at that size, so the
# favicons get a brighter tint and a larger mark. Same logo, legible small.
TAB = (0xb2, 0xbd, 0xc2)
for s in (16, 32):
    icon(s, frac=0.74, colour=TAB).save(f"{OUT}/icon-{s}.png")
icon(32, frac=0.74, colour=TAB).save(f"{OUT}/favicon-32.png")

# transparent mark for the in-app header
hm = mark_layer(192)
hm.save(f"{OUT}/mark.png")

# --- iOS PWA launch screens ---
SPL = os.path.expanduser("~/run-navi/icons/splash")
os.makedirs(SPL, exist_ok=True)
SIZES = [(1290, 2796), (1179, 2556), (1284, 2778), (1170, 2532), (1125, 2436), (828, 1792)]
try:
    from PIL import ImageFont
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Futura.ttc", 10)
except Exception:
    font = None

for w, h in SIZES:
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))
    lay = mark_layer(int(w * 0.42))
    im.paste(BRAND, ((w - lay.width) // 2, (h - lay.height) // 2 - int(h * 0.03)), lay)
    im.save(f"{SPL}/splash-{w}x{h}.png")

print("icons:", sorted(os.listdir(OUT)))
print("splash:", sorted(os.listdir(SPL)))
