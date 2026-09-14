#!/usr/bin/env python3
"""Independently verify ZIP names, stored bytes, CRCs, and every synthetic byte."""
import argparse
import hashlib
import json
import pathlib
import zipfile


def verify(path, kind):
    count, size = 120, {"small": 64 * 1024, "medium": 256 * 1024, "large": 512 * 1024}[kind]
    with zipfile.ZipFile(path) as archive:
        names = [f"synthetic-route-{i // 40}/{i % 40:04d}/rlog.zst" for i in range(count)]
        assert archive.namelist() == names, "Unexpected archive names/order or missing files"
        assert archive.testzip() is None, "ZIP CRC verification failed"
        for i, name in enumerate(names):
            info = archive.getinfo(name)
            assert info.compress_type == zipfile.ZIP_STORED, "Already-compressed input was recompressed"
            actual = archive.read(name)
            expected = bytes((i * 31 + n * 17 + (n >> 8)) & 255 for n in range(size))
            assert actual == expected, f"Byte mismatch in {name}"
    return {"status": "passed", "kind": kind, "files": count, "payloadBytes": count * size,
            "zipBytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=pathlib.Path)
    parser.add_argument("--kind", required=True, choices=["small", "medium", "large"])
    args = parser.parse_args()
    print(json.dumps(verify(args.path, args.kind), indent=2))
