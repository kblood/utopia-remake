"""List direct absolute-long JSR encodings for Utopia's RNG routines.

This is a read-only inventory of the loaded Disk.1 game-image bytes. It does not
claim that every listed site is reachable in a normal playthrough, nor does it
infer the caller's D0/D2 values. No game bytes are written or copied.

Usage: python tools/rng_call_sites.py [path/to/Disk.1]
"""
from __future__ import annotations

import sys
from pathlib import Path


DISK1_DEFAULT = Path(__file__).resolve().parent.parent / "original" / "utopia-whdload" / "Disk.1"
GAME_IMAGE_FILE_START = 0x14C * 0x200
GAME_IMAGE_FILE_END = 0x209 * 0x200  # exclusive; sectors $14C..$208
FILE_TO_GAME_ADDRESS_DELTA = 0x28800
RNG_TARGETS = (0x2DCA, 0x2DCC)


def find_calls(image: bytes, target: int) -> list[tuple[int, int]]:
    """Return (file offset, loaded game address) for JSR abs.l target encodings."""
    pattern = b"\x4e\xb9" + target.to_bytes(4, "big")
    offsets: list[tuple[int, int]] = []
    cursor = GAME_IMAGE_FILE_START
    while True:
        cursor = image.find(pattern, cursor, GAME_IMAGE_FILE_END)
        if cursor < 0:
            break
        offsets.append((cursor, cursor - FILE_TO_GAME_ADDRESS_DELTA))
        cursor += len(pattern)
    return offsets


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DISK1_DEFAULT
    if len(sys.argv) > 2:
        print("usage: python tools/rng_call_sites.py [path/to/Disk.1]", file=sys.stderr)
        return 2
    try:
        image = path.read_bytes()
    except OSError as exc:
        print(f"cannot read Disk.1: {exc}", file=sys.stderr)
        return 2

    expected_size = 970_752
    if len(image) != expected_size:
        print(f"warning: Disk.1 size is {len(image)} bytes (profile reference: {expected_size})", file=sys.stderr)

    total = 0
    for target in RNG_TARGETS:
        calls = find_calls(image, target)
        total += len(calls)
        print(f"JSR abs.l ${target:04X}: {len(calls)} site(s)")
        for file_offset, game_address in calls:
            print(f"  file +${file_offset:06X} -> game ${game_address:06X}")
    print(f"total: {total} direct call encoding(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
