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


def verify_ui_selection(path):
    """Verify last-seven-upload-days selects only the three intended routes."""
    expected = {}
    for route_index in range(3):
        route = f"2020-01-{route_index + 1:02d}--08-00-00"
        for segment in range(2):
            name = (f"syntheticdevice__{route}/rlog/"
                    f"syntheticdevice_{route}--{segment}--rlog.zst")
            expected[name] = bytes([64 + route_index * 16 + segment * 6]) * 4096
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == sorted(expected), "Upload-date selection included wrong routes or types"
        assert archive.testzip() is None, "Selected ZIP CRC verification failed"
        for name, data in expected.items():
            assert archive.read(name) == data, f"Selected payload mismatch in {name}"
    return {"status":"passed", "kind":"ui-selection", "files":len(expected), "routes":3,
            "dateBasis":"upload date; unrelated recording dates are all in 2020",
            "includedUploadDaysAgo":[0,2,6], "excludedUploadDaysAgo":[8,31],
            "payloadBytes":sum(map(len, expected.values())), "zipBytes":path.stat().st_size,
            "sha256":hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=pathlib.Path)
    parser.add_argument("--kind", required=True, choices=["small", "medium", "large", "ui-selection"])
    args = parser.parse_args()
    report = verify_ui_selection(args.path) if args.kind == 'ui-selection' else verify(args.path, args.kind)
    print(json.dumps(report, indent=2))
