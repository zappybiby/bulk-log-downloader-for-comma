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


def verify_ui_selection(path, date_basis='upload'):
    """Verify a Last 7 selection using independently specified route identities."""
    assert date_basis in ('upload', 'recording'), 'Unsupported selection date basis'
    indices = (0, 1, 2) if date_basis == 'upload' else (1, 3, 4)
    expected = {}
    for route_index in indices:
        route = f"2020-01-{route_index + 1:02d}--08-00-00"
        for segment in range(2):
            name = (f"syntheticdevice__{route}/rlog/"
                    f"syntheticdevice_{route}--{segment}--rlog.zst")
            expected[name] = bytes([64 + route_index * 16 + segment * 6]) * 4096
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == sorted(expected), f"{date_basis} date selection included wrong routes or types"
        assert archive.testzip() is None, "Selected ZIP CRC verification failed"
        for name, data in expected.items():
            assert archive.getinfo(name).compress_type == zipfile.ZIP_STORED
            assert archive.read(name) == data, f"Selected payload mismatch in {name}"
    report = {"status":"passed", "kind":"ui-selection" if date_basis == 'upload' else "ui-recording",
              "files":len(expected), "routes":3, "includedRouteIndices":list(indices),
              "dateBasis":"device table upload date" if date_basis == 'upload' else "route metadata start_time calendar date",
              "payloadBytes":sum(map(len, expected.values())), "zipBytes":path.stat().st_size,
              "sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    if date_basis == 'upload':
        report.update(includedUploadDaysAgo=[0,2,6], excludedUploadDaysAgo=[8,31], excludedRouteIndices=[3,4])
    else:
        report.update(includedRecordingDaysAgo=[1,0,6], excludedRecordingDaysAgo=[20,8], excludedRouteIndices=[0,2])
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=pathlib.Path)
    parser.add_argument("--kind", required=True, choices=["small", "medium", "large", "ui-selection", "ui-recording"])
    args = parser.parse_args()
    if args.kind in ('ui-selection', 'ui-recording'):
        report = verify_ui_selection(args.path, 'recording' if args.kind == 'ui-recording' else 'upload')
    else:
        report = verify(args.path, args.kind)
    print(json.dumps(report, indent=2))
