#!/usr/bin/env python3
"""Run only the offline recording-discovery experiment in Android Nightly."""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/android'))
from run import Harness, PACKAGE  # Reuse established, UI-tree-driven Nightly setup.


def verify_report(report):
    assert report['status'] == 'passed'
    assert report['kind'] == 'firefox-browser-synthetic-recording-discovery'
    assert 'Firefox/' in report['environment']['userAgent']
    assert 'Android' in report['environment']['userAgent']
    assert report['assumptions']['responseDelayMs'] == 20
    assert report['assumptions']['fixtureFileLinksPerRoute'] == 120
    assert len(report['rows']) == 20
    strategies = {
        'eager-all-links-pool-4': 4,
        'metadata-first-pool-1': 1,
        'metadata-first-pool-4': 4,
        'metadata-first-pool-8': 8,
        'warm-date-cache-pool-4': 4,
    }
    seen = set()
    for row in report['rows']:
        count, repetition, strategy = row['routes'], row['repetition'], row['strategy']
        assert count in (300, 1000) and repetition in (1, 2) and strategy in strategies
        identity = (count, repetition, strategy)
        assert identity not in seen
        seen.add(identity)
        selected = [route for route in range(count) if route % 41 != 0 and (route * 17 + 3) % 60 <= 6]
        cache = {route for route in range(count)
                 if route % 20 and route % 41 and route % 29 and route % 37}
        if strategy != 'warm-date-cache-pool-4':
            cache = set()
        expected_reads = sum(route not in cache or route in selected for route in range(count))
        tokens = sorted(f'{route}/{segment}' for route in selected for segment in range(20))
        expected_digest = hashlib.sha256('\n'.join(tokens).encode()).hexdigest()
        assert row['selectionSha256'] == expected_digest, identity
        assert row['matchedRoutes'] == len(selected), identity
        assert row['selectedRlogs'] == len(tokens), identity
        assert row['detailRequests'] == expected_reads, identity
        assert row['cacheEntries'] == len(cache), identity
        assert row['workers'] == strategies[strategy]
        assert 0 < row['peakInFlight'] <= row['workers']
        assert row['enumeratedFileLinks'] == (count if strategy.startswith('eager') else len(selected)) * 120
        assert row['totalMeasuredParseCpuMs'] > 0 and row['wallMs'] > 0
        assert row['correct'] is True
    return {'status': 'passed', 'verifiedRuns': len(seen),
            'selectionVerification': 'Independent route/date model and SHA-256 of every selected route/segment token',
            'scope': 'Native Android Firefox parsing; synthetic response delay; no real network timing'}


class DiscoveryHarness(Harness):
    def dismiss_prompts(self):
        nodes = self.nodes()
        if self.find(r'^Comma discovery synthetic Android test was added$', nodes) is not None:
            confirm = self.find(r'^OK$', nodes)
            if confirm is not None:
                self.tap(confirm)
                return True
        test_tab = self.find(r'^Discovery Android benchmark$', nodes) if self.waiting_for_test_tab else None
        if test_tab is not None:
            self.tap(test_tab)
            return True
        return super().dismiss_prompts()

    def start_extension(self):
        self.log = (self.output / 'web-ext.log').open('w')
        self.webext = subprocess.Popen([
            str(ROOT / 'node_modules/.bin/web-ext'), 'run', '--target=firefox-android',
            f'--adb-device={self.serial}', f'--firefox-apk={PACKAGE}',
            f'--source-dir={ROOT / ".android-selftest/discovery"}',
            '--no-reload', '--no-input', '--verbose', '--adb-remove-old-artifacts'
        ], cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT)
        self.waiting_for_test_tab = True
        try:
            self.await_text('DISCOVERY READY', timeout=210)
        finally:
            self.waiting_for_test_tab = False
        self.snapshot('discovery-ready')

    def exercise(self):
        self.click('^Run discovery benchmark$')
        until = time.monotonic() + 480
        while time.monotonic() < until:
            tree = self.device.dump_hierarchy()
            if 'DISCOVERY FAIL' in tree:
                self.snapshot('discovery-failure')
                raise AssertionError('Browser benchmark reported failure')
            if 'DISCOVERY PASS 20 RUNS' in tree:
                break
            if self.webext.poll() is not None:
                raise RuntimeError('web-ext exited during benchmark')
            time.sleep(3)
        else:
            self.snapshot('discovery-timeout')
            raise TimeoutError('Discovery benchmark did not complete')
        self.snapshot('discovery-complete')
        self.click('^Save benchmark JSON$')
        until = time.monotonic() + 90
        while time.monotonic() < until:
            self.dismiss_prompts()
            listing = self.adb('shell', 'find', '/sdcard/Download', '-maxdepth', '1', '-type',
                               'f', '-name', 'comma-discovery-report*.json', check=False, text=True).stdout
            paths = [line.strip() for line in listing.splitlines() if line.startswith('/sdcard/')]
            if paths:
                destination = self.output / 'discovery-report.json'
                self.adb('pull', paths[0], str(destination))
                try:
                    report = json.loads(destination.read_text())
                except (OSError, ValueError):
                    time.sleep(1)
                    continue
                verified = verify_report(report)
                (self.output / 'discovery-verified.json').write_text(json.dumps(verified, indent=2))
                for row in report['rows']:
                    print(json.dumps({key: row[key] for key in ('routes', 'repetition', 'strategy', 'wallMs',
                        'totalMeasuredParseCpuMs', 'detailRequests', 'matchedRoutes', 'heartbeatLagP95Ms')}), flush=True)
                print(json.dumps(verified), flush=True)
                self.snapshot('discovery-json-saved')
                return
            time.sleep(2)
        self.snapshot('discovery-save-failed')
        raise AssertionError('Benchmark JSON not saved through native Firefox download')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'android-results/discovery')
    args = parser.parse_args()
    harness = DiscoveryHarness(args.serial, args.output)
    try:
        harness.prepare()
        harness.start_extension()
        harness.exercise()
    finally:
        harness.close()


if __name__ == '__main__':
    main()
