"""
Generates rightread's app icons.

Design: a cream bookmark on Claude clay. A bookmark is the read-later
metaphor, and its silhouette stays legible shrunk to 48px on a home screen,
which an abstract mark does not.

Two variants, because Android treats them differently:
  - "any"      rounded square, used in browser UI and on desktop
  - "maskable" full-bleed, because the launcher crops it to whatever shape the
               phone uses (circle, squircle, teardrop). Everything meaningful
               must sit inside the central 80% "safe zone" or it gets cut off —
               that is what turned the first icon into a set of stripes.

Rendered at 4x and downsampled, so curves are anti-aliased rather than the
hard pixel edges the previous generator produced.

Run: python scripts/make-icons.py
"""

import os
import struct
import zlib

CLAY = (217, 119, 87)    # #D97757
CREAM = (250, 249, 245)  # #FAF9F5

SS = 4  # supersample factor


def bookmark_alpha(u: float, v: float, scale: float) -> float:
    """Coverage of the bookmark mark at normalised icon coords (0..1)."""
    half_w, half_h = 0.185 * scale, 0.265 * scale
    x0, x1 = 0.5 - half_w, 0.5 + half_w
    y0, y1 = 0.5 - half_h, 0.5 + half_h
    if not (x0 <= u <= x1 and y0 <= v <= y1):
        return 0.0

    # Rounded top corners.
    r = 0.045 * scale
    if v < y0 + r:
        if u < x0 + r and (u - (x0 + r)) ** 2 + (v - (y0 + r)) ** 2 > r * r:
            return 0.0
        if u > x1 - r and (u - (x1 - r)) ** 2 + (v - (y0 + r)) ** 2 > r * r:
            return 0.0

    # V notch cut up from the bottom edge — what makes this read as a bookmark
    # rather than a plain rectangle.
    notch = 0.16 * scale
    edge = (y1 - notch) + notch * abs(u - 0.5) / half_w
    if v > edge:
        return 0.0

    return 1.0


def rounded_square_alpha(u: float, v: float) -> float:
    pad, r = 0.045, 0.235
    x0, x1 = pad, 1 - pad
    y0, y1 = pad, 1 - pad
    if not (x0 <= u <= x1 and y0 <= v <= y1):
        return 0.0
    cx = min(max(u, x0 + r), x1 - r)
    cy = min(max(v, y0 + r), y1 - r)
    if (u - cx) ** 2 + (v - cy) ** 2 > r * r:
        return 0.0
    return 1.0


def render(size: int, maskable: bool) -> bytes:
    # Maskable art gets cropped, so the mark shrinks to stay in the safe zone.
    scale = 0.78 if maskable else 1.0
    px = bytearray()
    for y in range(size):
        px.append(0)  # PNG filter byte: none
        for x in range(size):
            bg_a = 0.0
            mark_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    bg_a += 1.0 if maskable else rounded_square_alpha(u, v)
                    mark_a += bookmark_alpha(u, v, scale)
            n = float(SS * SS)
            bg_a /= n
            mark_a /= n

            r = CLAY[0] * (1 - mark_a) + CREAM[0] * mark_a
            g = CLAY[1] * (1 - mark_a) + CREAM[1] * mark_a
            b = CLAY[2] * (1 - mark_a) + CREAM[2] * mark_a
            px += bytes((round(r), round(g), round(b), round(255 * bg_a)))
    return bytes(px)


def write_png(path: str, size: int, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(raw, 9))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(out)


def main() -> None:
    os.makedirs("public", exist_ok=True)
    os.makedirs("extension/icons", exist_ok=True)

    for size in (192, 512):
        write_png(f"public/icon-{size}.png", size, render(size, maskable=False))
        write_png(
            f"public/icon-maskable-{size}.png", size, render(size, maskable=True)
        )

    write_png("public/apple-touch-icon.png", 180, render(180, maskable=False))
    write_png("public/favicon.png", 32, render(32, maskable=False))

    for size in (16, 32, 128):
        write_png(
            f"extension/icons/icon-{size}.png", size, render(size, maskable=False)
        )

    print("icons written")


if __name__ == "__main__":
    main()
