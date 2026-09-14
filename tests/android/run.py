#!/usr/bin/env python3
"""Drive a fresh Android emulator. Only synthetic test pages are opened."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

import uiautomator2 as u2
from verify import verify

ROOT = pathlib.Path(__file__).resolve().parents[2]
PACKAGE = 'org.mozilla.fenix'


class Harness:
    def __init__(self, serial, output):
        self.serial, self.output = serial, output
        self.output.mkdir(parents=True, exist_ok=True)
        self.device = u2.connect(serial)
        self.webext = None
        self.log = None
        self.archive_results = []

    def adb(self, *args, check=True, **kwargs):
        return subprocess.run(['adb', '-s', self.serial, *args], check=check,
                              capture_output=True, **kwargs)

    def snapshot(self, name):
        self.device.screenshot(str(self.output / f'{name}.png'))
        xml = self.device.dump_hierarchy()
        (self.output / f'{name}.xml').write_text(xml)
        return xml

    def nodes(self):
        return list(ET.fromstring(self.device.dump_hierarchy()).iter('node'))

    def find(self, pattern):
        regex = re.compile(pattern, re.I)
        return next((node for node in self.nodes() if any(regex.search(node.get(key, ''))
                     for key in ('text', 'content-desc', 'resource-id'))
                     and node.get('enabled') != 'false'), None)

    def tap(self, node):
        bounds = list(map(int, re.findall(r'\d+', node.attrib['bounds'])))
        x1, y1, x2, y2 = bounds
        if x2 <= x1 or y2 <= y1:
            raise RuntimeError('UI node has no visible bounds')
        self.device.click((x1 + x2) // 2, (y1 + y2) // 2)

    def click(self, pattern, timeout=15, scroll=False):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            node = self.find(pattern)
            if node is not None:
                self.tap(node)
                return
            if scroll:
                self.device.swipe_ext('up', scale=0.65)
            time.sleep(0.5)
        self.snapshot('missing-control')
        raise RuntimeError(f'Missing UI control: {pattern}')

    def await_text(self, text, timeout=120, scroll=False):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            tree = self.device.dump_hierarchy()
            if 'SELFTEST FAIL' in tree:
                self.snapshot('selftest-failure')
                raise AssertionError('Archive self-test failed; inspect selftest-failure.xml')
            if text in tree:
                return
            if self.webext is not None and self.webext.poll() is not None:
                raise RuntimeError('web-ext exited; inspect web-ext.log')
            self.dismiss_prompts()
            if scroll:
                self.device.swipe_ext('up', scale=0.5)
            time.sleep(1)
        self.snapshot('timed-out')
        raise TimeoutError(f'Timed out waiting for {text}')

    def dismiss_prompts(self):
        if self.find(r'^Comma archive synthetic Android test was added$') is not None:
            self.snapshot('extension-installed-confirmation')
            self.click(r'^OK$')
            print('Dismissed Firefox temporary-extension install confirmation', flush=True)
            return True
        # Firefox can restore its home screen after the install sheet even
        # though onInstalled already opened our extension tab (shown under Continue).
        test_tab = self.find(r'^Archive Android self-test$')
        if test_tab is not None:
            self.tap(test_tab)
            print('Opening the existing synthetic test tab from Firefox home', flush=True)
            return True
        for pattern in (r'^Not now$', r'^No Thanks$', r'^No$', r'^Skip$', r'^Maybe later$',
                        r'^Start browsing$', r'^Continue browsing$',
                        r'^Continue$', r'^Allow$', r'^Allow connection$', r'^Download$'):
            node = self.find(pattern)
            if node is not None:
                self.tap(node)
                time.sleep(0.3)
                return True
        return False

    def prepare(self):
        self.adb('logcat', '-c')
        print('Launching installed Firefox Nightly', flush=True)
        self.device.app_start(PACKAGE)
        time.sleep(3)
        # Use UI controls first. Bounds always come from the accessibility tree.
        for _ in range(30):
            # Cold-boot Android images sometimes leave the launcher ANR dialog
            # above the newly opened app. Only recover that setup-only failure.
            # A Firefox ANR/crash during the actual test remains a test failure.
            launcher_anr = self.find(r"^Pixel Launcher isn.t responding$")
            if launcher_anr is not None:
                self.snapshot('launcher-startup-anr')
                print('Dismissing cold-boot Pixel Launcher ANR; restarting Nightly', flush=True)
                self.click(r'^Close app$')
                self.device.app_start(PACKAGE)
                time.sleep(3)
                continue
            if self.find(r'^Set Firefox Nightly as your default browser app\?$') is not None:
                self.snapshot('default-browser-startup-dialog')
                print('Dismissing Android default-browser setup dialog', flush=True)
                self.click(r'^Cancel$')
                time.sleep(1)
                continue
            if self.find(r'(^Menu$|More options|menuButton|menu_button)') is not None:
                break
            if not self.dismiss_prompts():
                time.sleep(1)
        self.snapshot('nightly-first-launch')
        self.click(r'(^Menu$|More options|menuButton|menu_button)')
        self.click(r'^Settings$', scroll=True)
        self.click(r'Remote debugging via USB', timeout=25, scroll=True)
        self.snapshot('remote-debugging-enabled')
        print('Firefox remote debugging enabled through Settings', flush=True)
        self.device.press('back')
        self.device.press('back')
        self.adb('shell', 'dumpsys', 'package', PACKAGE, text=True)
        package = self.adb('shell', 'dumpsys', 'package', PACKAGE, text=True).stdout
        version = [line.strip() for line in package.splitlines() if 'versionName=' in line or 'versionCode=' in line]
        (self.output / 'device.json').write_text(json.dumps({
            'serial':self.serial, 'package':PACKAGE, 'version':version,
            'android':self.adb('shell', 'getprop', 'ro.build.version.release', text=True).stdout.strip(),
            'abi':self.adb('shell', 'getprop', 'ro.product.cpu.abi', text=True).stdout.strip()
        }, indent=2))

    def start_extension(self):
        self.log = (self.output / 'web-ext.log').open('w')
        self.webext = subprocess.Popen([
            str(ROOT / 'node_modules/.bin/web-ext'), 'run', '--target=firefox-android',
            f'--adb-device={self.serial}', f'--firefox-apk={PACKAGE}',
            f'--source-dir={ROOT / ".android-selftest"}', '--no-reload', '--no-input', '--verbose',
            '--adb-remove-old-artifacts'
        ], cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT)
        self.await_text('SELFTEST READY', timeout=210)
        self.snapshot('selftest-ready')
        print('Synthetic extension installed and open in Firefox Nightly', flush=True)

    def pull_zip(self, kind):
        until = time.monotonic() + 120
        while time.monotonic() < until:
            self.dismiss_prompts()
            listing = self.adb('shell', 'find', '/sdcard/Download', '-maxdepth', '1', '-type',
                               'f', '-name', f'comma-selftest-{kind}*.zip', check=False, text=True).stdout
            paths = [line.strip() for line in listing.splitlines() if line.startswith('/sdcard/')]
            if paths:
                destination = self.output / f'comma-selftest-{kind}.zip'
                self.adb('pull', paths[0], str(destination))
                try:
                    report = verify(destination, kind)
                    (self.output / f'{kind}-verified.json').write_text(json.dumps(report, indent=2))
                    print(json.dumps(report), flush=True)
                    return
                except (AssertionError, OSError, ValueError, zipfile.BadZipFile):
                    # A download may exist on disk before Firefox has finished writing.
                    pass
            time.sleep(2)
        self.snapshot('zip-save-failed')
        raise AssertionError(f'No complete, independently verified {kind} ZIP in Android Downloads')

    def exercise(self):
        for kind in ('small', 'medium'):
            self.click(f'^{kind.title()} ZIP test$')
            self.await_text(f'{kind.upper()} READY 120 FILES', timeout=180)
            self.snapshot(f'{kind}-ready')
            texts = ' '.join(node.get('text', '') for node in self.nodes())
            storage = re.search(r'"storage":\s*"(opfs|memory)"', texts)
            if not storage:
                raise AssertionError('Storage mode missing from archive report')
            self.archive_results.append({'kind':kind, 'storage':storage.group(1)})
            self.click('^Save synthetic ZIP$')
            self.pull_zip(kind)
            self.snapshot(f'{kind}-saved')
        if self.archive_results[-1]['storage'] == 'opfs':
            self.click('^Disk ZIP test$')
            self.await_text('LARGE READY 120 FILES', timeout=180)
            self.snapshot('large-ready')
            self.click('^Save synthetic ZIP$')
            self.pull_zip('large')
            self.archive_results.append({'kind':'large', 'storage':'opfs'})
        self.click('^Cancellation test$')
        self.await_text('CANCEL PASS', timeout=30)
        self.snapshot('cancellation-pass')
        self.click('^HTTP failure test$')
        self.await_text('FAILURE PASS', timeout=30)
        self.snapshot('http-failure-pass')
        self.click('^Open downloader UI$')
        self.await_text('Synthetic route', timeout=30)
        self.snapshot('production-ui-source')
        self.click('Scan files', timeout=20, scroll=True)
        self.click('Prepare ZIP', timeout=30, scroll=True)
        self.await_text('Save ZIP', timeout=30, scroll=True)
        self.snapshot('production-ui-zip-ready')
        # Capture the top of the populated production layout as well as the save controls.
        self.device.swipe_ext('down', scale=0.8)
        self.device.swipe_ext('down', scale=0.8)
        self.snapshot('production-ui-populated')
        (self.output / 'result.json').write_text(json.dumps({
            'status':'passed', 'archiveRuns':self.archive_results,
            'largestVerifiedPayloadMiB':60 if len(self.archive_results) == 3 else 30,
            'diskAbove32MiB':'passed' if len(self.archive_results) == 3 else 'not available; memory fallback',
            'smallZipFiles':120, 'mediumZipFiles':120,
            'smallPayloadMiB':7.5, 'mediumPayloadMiB':30,
            'cancellation':'passed', 'httpFailure':'passed',
            'productionUi':'synthetic API adapter; production HTML/CSS/handlers',
            'liveAuthentication':'not tested', 'backgroundDownloads':'not tested'
        }, indent=2))

    def close(self):
        try:
            self.snapshot('final-screen')
        except Exception:
            pass
        for name, args in [('logcat.txt', ['logcat', '-d']),
                           ('crash-log.txt', ['logcat', '-b', 'crash', '-d']),
                           ('memory.txt', ['shell', 'dumpsys', 'meminfo', PACKAGE])]:
            try:
                (self.output / name).write_bytes(self.adb(*args, check=False).stdout)
            except Exception:
                pass
        if self.webext is not None:
            self.webext.terminate()
            try:
                self.webext.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.webext.kill()
        if self.log is not None:
            self.log.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'android-results')
    args = parser.parse_args()
    harness = Harness(args.serial, args.output)
    try:
        harness.prepare()
        harness.start_extension()
        harness.exercise()
    finally:
        harness.close()


if __name__ == '__main__':
    main()
