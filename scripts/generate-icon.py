import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "desktop", "assets")
os.makedirs(OUT_DIR, exist_ok=True)


def draw_icon(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * 0.06)
    radius = int(size * 0.22)
    # Deep scientific teal background tile
    draw.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=radius,
        fill=(15, 118, 110, 255),
        outline=(20, 148, 138, 255),
        width=max(2, size // 64),
    )

    # Subtle inner highlight arc
    cx, cy = size // 2, size // 2
    lw = max(4, int(size * 0.042))

    # Flask neck & rim
    neck_w = int(size * 0.15)
    rim_w = int(size * 0.22)
    top_y = int(size * 0.21)
    neck_bot = int(size * 0.39)
    base_y = int(size * 0.77)
    base_half = int(size * 0.27)

    # Rim bar
    draw.line([(cx - rim_w // 2, top_y), (cx + rim_w // 2, top_y)], fill=(255, 255, 255, 255), width=lw)

    # Flask polygon outline
    flask_pts = [
        (cx - neck_w // 2, top_y),
        (cx - neck_w // 2, neck_bot),
        (cx - base_half, base_y - int(size * 0.04)),
        (cx - base_half + int(size * 0.04), base_y),
        (cx + base_half - int(size * 0.04), base_y),
        (cx + base_half, base_y - int(size * 0.04)),
        (cx + neck_w // 2, neck_bot),
        (cx + neck_w // 2, top_y),
    ]

    # Liquid fill inside lower flask
    liq_y = int(size * 0.59)
    liq_half = int(size * 0.185)
    draw.polygon(
        [
            (cx - liq_half, liq_y),
            (cx - base_half + int(size * 0.03), base_y - int(size * 0.025)),
            (cx + base_half - int(size * 0.03), base_y - int(size * 0.025)),
            (cx + liq_half, liq_y),
        ],
        fill=(56, 189, 248, 220),
    )

    draw.line(flask_pts, fill=(255, 255, 255, 255), width=lw, joint="curve")

    # Scientific node dots (representing DAG / molecules)
    for dx, dy, r in [(-0.07, 0.14, 0.032), (0.06, 0.18, 0.028), (0.01, 0.04, 0.026)]:
        bx, by, br = int(cx + size * dx), int(cy + size * dy), max(3, int(size * r))
        draw.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255, 245))

    return img


def main():
    base = draw_icon(512)
    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    base.save(png_path, format="PNG")
    base.save(ico_path, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("Generated:", png_path, ico_path)


if __name__ == "__main__":
    main()
