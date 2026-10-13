# Builds the profile pictures in assets/avatars/ from the sprite sheets:
# the front-facing frame (top-left 64x64), cropped to the Pokémon itself and
# centred on a square canvas with a little padding.
#
#   python3 tools/make-avatars.py
#
# Run it again after adding a sprite to AVATARS in src/profile.js.
import re
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
ids = re.findall(r"'([a-z0-9-]+)'", re.search(r"AVATARS = \[(.*?)\]", (root / 'src/profile.js').read_text(), re.S).group(1))
out = root / 'assets/avatars'
out.mkdir(exist_ok=True)
for id in ids:
    frame = Image.open(root / f'assets/sprites/{id}.png').convert('RGBA').crop((0, 0, 64, 64))
    box = frame.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    body = frame.crop(box)
    side = max(body.width, body.height) + 4  # 2px padding all round
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(body, ((side - body.width) // 2, (side - body.height) // 2))
    canvas.save(out / f'{id}.png', optimize=True)
    print(f'{id}: {body.width}x{body.height} -> {side}x{side}')
