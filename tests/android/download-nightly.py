#!/usr/bin/env python3
"""Resolve Mozilla's official Taskcluster index and record exact build provenance."""
import argparse
import hashlib
import json
import pathlib
import urllib.request

# Updated to the current Gecko Taskcluster index after inspecting Mozilla's task definitions.
INDEX = "gecko.v2.mozilla-central.latest.mobile.fenix-nightly"
API = "https://firefox-ci-tc.services.mozilla.com/api"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    index_url = f"{API}/index/v1/task/{INDEX}"
    with urllib.request.urlopen(index_url, timeout=60) as response:
        index = json.load(response)
    task_id = index["taskId"]
    with urllib.request.urlopen(f"{API}/queue/v1/task/{task_id}", timeout=60) as response:
        task = json.load(response)
    if task["metadata"]["name"] != "signing-apk-fenix-nightly":
        raise RuntimeError("Nightly index did not resolve to Mozilla\'s signed Nightly task")
    with urllib.request.urlopen(f"{API}/queue/v1/task/{task_id}/artifacts", timeout=60) as response:
        artifacts = json.load(response)["artifacts"]
    matches = [item["name"] for item in artifacts if item["name"].endswith(".apk")
               and "x86_64" in item["name"] and "androidTest" not in item["name"]]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one official x86_64 APK, found: {matches}")
    url = f"{API}/queue/v1/task/{task_id}/artifacts/{matches[0]}"
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, args.output.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    provenance = {"index": INDEX, "taskId": task_id, "artifact": matches[0], "url": url,
                  "sha256": digest.hexdigest(), "bytes": args.output.stat().st_size}
    args.output.with_suffix(".json").write_text(json.dumps(provenance, indent=2))
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
