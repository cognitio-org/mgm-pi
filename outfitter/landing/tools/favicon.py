#!/usr/bin/env python3
"""Write the Kernal/Outfitter favicon into the landing page and the web app.

One 16x16 rucksack, the same pixels as LogoMark. The pocket is a solid cutout
(a translucent panel disappears at tab size) and the cursor blinks in the SVG.

The SVG and ICO have no tile: a tile flips to a cream square on dark tab bars. The
rucksack is purple on light tabs and cream on dark ones (prefers-color-scheme), and
its cutouts are transparent. The ICO is the light colours, for browsers that ignore
SVG. The home-screen PNG keeps the purple tile, since iOS fills transparency.
"""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTS = [
    ROOT / "landing" / "public",
    ROOT / "packages" / "web" / "public",
]

# Tab icons (SVG, ICO): pack, cursor on a transparent background.
LIGHT = ("#302870", "#1f8a4c")
DARK = ("#f1ebdd", "#5cff8a")
# Home-screen icon: tile, pack, cursor. Cuts punch back to the tile.
TOUCH = ("#302870", "#f4efe4", "#5cff8a")
PACK = [
    (5, 0, 2, 5),
    (9, 0, 2, 5),
    (4, 3, 8, 2),
    (3, 4, 10, 11),
]
CUTS = [(7, 6, 2, 2), (5, 9, 6, 5)]
CURSOR = (12, 12, 2, 3)


def svg() -> str:
    def rects(items: list[tuple[int, int, int, int]], cls: str) -> str:
        fill = ' fill="#000"' if cls == "cut" else ""
        return "\n".join(
            f'  <rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}"{fill}/>'
            for x, y, w, h in items
        )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <title>Kernal</title>
  <style>
    .pack {{ fill: {LIGHT[0]}; }}
    .cursor {{ fill: {LIGHT[1]}; }}
    @media (prefers-color-scheme: dark) {{
      .pack {{ fill: {DARK[0]}; }}
      .cursor {{ fill: {DARK[1]}; }}
    }}
    @media (prefers-reduced-motion: no-preference) {{
      .cursor {{ animation: blink 1.2s steps(1) infinite; }}
    }}
    @keyframes blink {{ 50% {{ opacity: 0; }} }}
  </style>
  <defs>
    <mask id="cuts">
      <rect width="16" height="16" fill="#fff"/>
{rects(CUTS, "cut")}
    </mask>
  </defs>
  <g mask="url(#cuts)">
{rects(PACK, "pack")}
  </g>
  <rect class="cursor" x="{CURSOR[0]}" y="{CURSOR[1]}" width="{CURSOR[2]}" height="{CURSOR[3]}"/>
</svg>
"""


def hex_rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color[i : i + 2], 16) for i in (1, 3, 5))  # type: ignore[return-value]


def raster(tile: str | None, pack: str, cursor: str) -> list[list[tuple[int, int, int, int]]]:
    """The 16x16 grid; tile=None leaves the background and the cutouts transparent."""
    bg = (*hex_rgb(tile), 255) if tile else (0, 0, 0, 0)
    grid = [[bg for _ in range(16)] for _ in range(16)]

    def paint(rects: list[tuple[int, int, int, int]], color: tuple[int, int, int, int]) -> None:
        for x, y, w, h in rects:
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    grid[yy][xx] = color

    paint(PACK, (*hex_rgb(pack), 255))
    paint(CUTS, bg)
    paint([CURSOR], (*hex_rgb(cursor), 255))
    return grid


def png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def scale(grid: list[list[tuple[int, int, int, int]]], factor: int) -> list[bytes]:
    rows = []
    for row in grid:
        wide = b"".join(bytes(pixel) * factor for pixel in row)
        rows.extend([wide] * factor)
    return rows


def pad(rows: list[bytes], size: int, color: tuple[int, int, int, int]) -> list[bytes]:
    width = len(rows[0]) // 4
    px = bytes(color)
    out = []
    top = (size - len(rows)) // 2
    side = (size - width) // 2
    blank = px * size
    out.extend([blank] * top)
    for row in rows:
        out.append(px * side + row + px * (size - width - side))
    out.extend([blank] * (size - len(out)))
    return out


def ico(images: list[tuple[int, bytes]]) -> bytes:
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    blobs = b""
    offset = 6 + 16 * count
    for size, data in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return header + entries + blobs


def main() -> None:
    grid = raster(None, *LIGHT)
    png16 = png(16, 16, scale(grid, 1))
    png32 = png(32, 32, scale(grid, 2))
    touch_grid = raster(*TOUCH)
    touch = png(180, 180, pad(scale(touch_grid, 11), 180, (*hex_rgb(TOUCH[0]), 255)))
    icon = ico([(16, png16), (32, png32)])
    text = svg()
    for directory in OUTS:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "favicon.svg").write_text(text)
        (directory / "favicon.ico").write_bytes(icon)
        (directory / "apple-touch-icon.png").write_bytes(touch)
        print(directory.relative_to(ROOT))


if __name__ == "__main__":
    main()
