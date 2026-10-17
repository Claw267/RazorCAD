"""Generates assets/razorcad.ico (multi-size Windows icon) with Pillow."""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'razorcad.ico')


def draw(size):
    s = 256
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # red rounded tile with a subtle vertical gradient
    for y in range(s):
        t = y / s
        col = (int(229 - 60 * t), int(57 - 30 * t), int(53 - 30 * t), 255)
        d.line([(0, y), (s, y)], fill=col)
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([8, 8, s - 8, s - 8], radius=48, fill=255)
    tile = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    tile.paste(img, (0, 0), mask)
    d = ImageDraw.Draw(tile)
    # isometric cube outline
    cx, cy, r = 128, 136, 78
    top = [(cx, cy - r), (cx + r, cy - r // 2), (cx, cy), (cx - r, cy - r // 2)]
    d.polygon(top, fill=(255, 224, 130, 255))
    d.polygon([(cx - r, cy - r // 2), (cx, cy), (cx, cy + r), (cx - r, cy + r // 2)], fill=(236, 239, 244, 255))
    d.polygon([(cx + r, cy - r // 2), (cx, cy), (cx, cy + r), (cx + r, cy + r // 2)], fill=(176, 186, 200, 255))
    for poly in (top,):
        d.line(poly + [poly[0]], fill=(60, 40, 20, 255), width=6)
    d.line([(cx - r, cy - r // 2), (cx - r, cy + r // 2), (cx, cy + r), (cx + r, cy + r // 2), (cx + r, cy - r // 2)], fill=(40, 48, 60, 255), width=6)
    d.line([(cx, cy), (cx, cy + r)], fill=(40, 48, 60, 255), width=6)
    return tile.resize((size, size), Image.LANCZOS)


os.makedirs(os.path.dirname(OUT), exist_ok=True)
base = draw(256)
base.save(OUT, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('wrote', OUT)
