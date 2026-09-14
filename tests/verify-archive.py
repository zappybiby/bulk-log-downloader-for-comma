#!/usr/bin/env python3
"""Independently verify an archive produced by the production JS engine."""

import hashlib
import json
import sys
import zipfile


def verify(archive_path, manifest_path):
    with open(manifest_path, encoding="utf-8") as source:
        expected = json.load(source)
    with zipfile.ZipFile(archive_path) as archive:
        assert archive.testzip() is None, "ZIP CRC validation failed"
        assert archive.namelist() == list(expected), "Archive paths or file order changed"
        for name, metadata in expected.items():
            info = archive.getinfo(name)
            assert info.compress_type == zipfile.ZIP_STORED, f"Unexpected recompression: {name}"
            assert info.flag_bits & 0x800, f"Missing UTF-8 flag: {name}"
            data = archive.read(name)
            assert len(data) == metadata["bytes"], f"Size mismatch: {name}"
            assert hashlib.sha256(data).hexdigest() == metadata["sha256"], f"Byte mismatch: {name}"
    print(f"Verified {len(expected)} file paths, CRCs, sizes and SHA-256 hashes.")


if __name__ == "__main__":
    verify(sys.argv[1], sys.argv[2])
