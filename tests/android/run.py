#!/usr/bin/env python3
"""Drive a fresh Android emulator. Only synthetic test pages are opened."""
import argparse
import datetime
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
from verify import verify, verify_ui_selection

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
        self.pulled_ui_paths = set()
        self.waiting_for_test_tab = False
        self.compact_ui_checks = []

    def adb(self, *args, check=True, **kwargs):
        return subprocess.run(['adb', '-s', self.serial, *args], check=check,
                              capture_output=True, **kwargs)

    def snapshot(self, name):
        # Accessibility can update before Gecko paints the matching frame.
        # Settle the frame so screenshots document the asserted UI state.
        time.sleep(0.4)
        xml = self.device.dump_hierarchy()
        (self.output / f'{name}.xml').write_text(xml)
        self.device.screenshot(str(self.output / f'{name}.png'))
        return xml

    def nodes(self):
        return list(ET.fromstring(self.device.dump_hierarchy()).iter('node'))

    def find(self, pattern, nodes=None):
        regex = re.compile(pattern, re.I)
        return next((node for node in (self.nodes() if nodes is None else nodes) if any(regex.search(node.get(key, ''))
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
        while True:
            node = self.find(pattern)
            if node is not None:
                self.tap(node)
                return
            # Inspect the result of the final swipe before declaring timeout.
            if time.monotonic() >= until:
                break
            # Android may show notification permission immediately after a ZIP
            # finishes, after pull_zip has already verified the saved file.
            if self.dismiss_prompts():
                continue
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
        # One accessibility snapshot per pass: separate RPCs for every label
        # made setup scrolls consume their deadline before the final lookup.
        nodes = self.nodes()
        if self.find(r'^Comma archive synthetic Android test was added$', nodes) is not None:
            confirm = self.find(r'^OK$', nodes)
            if confirm is None:
                return False
            self.snapshot('extension-installed-confirmation')
            self.tap(confirm)
            print('Dismissed Firefox temporary-extension install confirmation', flush=True)
            return True
        # Firefox can restore its home screen after the install sheet even
        # though onInstalled already opened our extension tab (shown under Continue).
        test_tab = self.find(r'^Archive Android self-test$', nodes) if self.waiting_for_test_tab else None
        if test_tab is not None:
            self.tap(test_tab)
            print('Opening the existing synthetic test tab from Firefox home', flush=True)
            return True
        # Firefox can place its save dialog above Android's delayed notification
        # permission sheet while both remain in the accessibility tree. Confirm
        # the visible save dialog first; tapping the occluded Allow button would
        # repeatedly hit the filename field instead and never start the download.
        if self.find(r'^Download file\?', nodes) is not None:
            download = self.find(r'^Download$', nodes)
            if download is not None:
                self.tap(download)
                time.sleep(0.3)
                return True
        for pattern in (r'^Not now$', r'^No Thanks$', r'^No$', r'^Skip$', r'^Maybe later$',
                        r'^Start browsing$', r'^Continue browsing$',
                        r'^Continue$', r'^Allow$', r'^Allow connection$', r'^Download$'):
            node = self.find(pattern, nodes)
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
        # The opening menu animates after its nodes first appear. A tap using
        # those early bounds can miss Settings; confirm the screen transition
        # before scrolling for a setting that is absent from the main menu.
        until = time.monotonic() + 20
        settings_open = False
        while time.monotonic() < until:
            nodes = self.nodes()
            settings = self.find(r'^Settings$', nodes)
            menu = self.find(r'^Close menu$', nodes)
            if settings is not None and menu is None:
                settings_open = True
                break
            if settings is not None:
                self.tap(settings)
            elif menu is not None:
                self.device.swipe_ext('up', scale=0.5)
            time.sleep(0.7)
        if not settings_open:
            self.snapshot('settings-navigation-failed')
            raise RuntimeError('Firefox did not navigate from its menu to Settings')
        self.click(r'Remote debugging via USB', timeout=45, scroll=True)
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
        self.waiting_for_test_tab = True
        try:
            self.await_text('SELFTEST READY', timeout=210)
        finally:
            self.waiting_for_test_tab = False
        self.snapshot('selftest-ready')
        print('Synthetic extension installed and open in Firefox Nightly', flush=True)

    def pull_zip(self, kind):
        is_ui = kind in ('ui-selection', 'ui-recording')
        pattern = 'comma-logs-*.zip' if is_ui else f'comma-selftest-{kind}*.zip'
        until = time.monotonic() + 120
        while time.monotonic() < until:
            self.dismiss_prompts()
            listing = self.adb('shell', 'find', '/sdcard/Download', '-maxdepth', '1', '-type',
                               'f', '-name', pattern, check=False, text=True).stdout
            paths = [line.strip() for line in listing.splitlines() if line.startswith('/sdcard/')]
            for path in paths:
                if is_ui and path in self.pulled_ui_paths:
                    continue
                destination = self.output / f'comma-selftest-{kind}.zip'
                self.adb('pull', path, str(destination))
                try:
                    if kind == 'ui-recording':
                        report = verify_ui_selection(destination, 'recording')
                    elif kind == 'ui-selection':
                        report = verify_ui_selection(destination)
                    else:
                        report = verify(destination, kind)
                    (self.output / f'{kind}-verified.json').write_text(json.dumps(report, indent=2))
                    print(json.dumps(report), flush=True)
                    if is_ui:
                        self.pulled_ui_paths.add(path)
                    return report
                except (AssertionError, OSError, ValueError, zipfile.BadZipFile):
                    # A download may exist on disk before Firefox has finished writing.
                    pass
            time.sleep(2)
        self.snapshot('zip-save-failed')
        raise AssertionError(f'No complete, independently verified {kind} ZIP in Android Downloads')

    def page_top(self):
        # Stop as soon as the heading is visible. Blind extra downward swipes at
        # scrollTop=0 invoke Firefox's pull-to-refresh and discard scan results.
        for _ in range(8):
            heading = self.find(r'^Bulk logs$')
            if heading is not None:
                bounds = list(map(int, re.findall(r'-?\d+', heading.attrib['bounds'])))
                if bounds[3] > bounds[1] >= 0:
                    return
            self.device.swipe_ext('down', scale=0.25)
            time.sleep(0.3)
        self.snapshot('page-top-not-found')
        raise RuntimeError('Could not reveal the downloader heading without reloading')

    @staticmethod
    def native_download_overlay(nodes):
        # These IDs and bounds come from actual Nightly accessibility captures.
        # Native download snackbars sit above the page's visible footer buttons.
        for node in nodes:
            if node.get('package') != PACKAGE or node.get('visible-to-user') == 'false':
                continue
            if node.get('resource-id') not in ('org.mozilla.fenix:id/dynamicSnackbarContainer', 'snackbar'):
                continue
            bounds = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
            if len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1]:
                return True
        return False

    def wait_for_native_download_ui(self, timeout=30):
        # Require a short, observed clear interval: a completed notification can
        # replace the in-progress snackbar just after the file verifies on disk.
        until, clear_since = time.monotonic() + timeout, None
        while time.monotonic() < until:
            if self.native_download_overlay(self.nodes()) or self.dismiss_prompts():
                clear_since = None
            else:
                clear_since = clear_since or time.monotonic()
                if time.monotonic() - clear_since >= 1:
                    return
            time.sleep(0.25)
        self.snapshot('native-download-overlay-stuck')
        raise TimeoutError('Firefox native download UI still covers the page controls')

    def start_ui_scan(self):
        self.wait_for_native_download_ui()
        self.click('^Scan files$', timeout=20)
        # A tap alone does not prove delivery: verify a state transition before
        # asserting results. Never retap while a scan may already be running.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            nodes = self.nodes()
            if self.find(r'^(cancel-scan-button|download-button|Scan complete.*)$', nodes) is not None:
                return
            time.sleep(0.25)
        self.snapshot('scan-did-not-start')
        raise AssertionError('Scan tap did not produce an active or completed scan')

    @staticmethod
    def node_bounds(node):
        values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
        if len(values) != 4:
            raise AssertionError('Accessibility node has no usable bounds')
        return values

    def assert_compact_view(self, name, controls, absent=()):
        # These controls must all fit at once. This helper never scrolls or taps;
        # it records the exact hierarchy used for assertions and a settled frame.
        nodes = list(ET.fromstring(self.snapshot(name)).iter('node'))
        webview = next((node for node in nodes if node.get('class') == 'android.webkit.WebView'
                        and 'Bulk logs' in node.get('text', '')), None)
        if webview is None:
            raise AssertionError(f'{name}: downloader WebView is missing')
        viewport = self.node_bounds(webview)
        footer_node = self.find(r'^Download actions$', nodes)
        if footer_node is None:
            raise AssertionError(f'{name}: download action bar is missing')
        footer = self.node_bounds(footer_node)
        if self.native_download_overlay(nodes):
            raise AssertionError(f'{name}: native download UI covers the page')
        observed = []
        for pattern in controls:
            node = self.find(pattern, nodes)
            if node is None or node.get('visible-to-user') == 'false':
                raise AssertionError(f'{name}: required control is not visible: {pattern}')
            bounds = self.node_bounds(node)
            x1, y1, x2, y2 = bounds
            if not (viewport[0] <= x1 < x2 <= viewport[2]
                    and viewport[1] <= y1 < y2 <= viewport[3]):
                raise AssertionError(f'{name}: control does not fit in WebView: {pattern} {bounds}')
            # All requested elements outside the footer must be above it.
            # Gecko sometimes exposes nodes under a footer in the UI tree;
            # simple presence would miss that obstruction.
            in_footer = footer[0] <= x1 and x2 <= footer[2] and footer[1] <= y1 and y2 <= footer[3]
            footer_ids = {'action-summary', 'scan-button', 'download-button', 'save-button',
                          'review-button', 'clear-button', 'cancel-scan-button', 'stop-button'}
            if node.get('resource-id') in footer_ids:
                if not in_footer:
                    raise AssertionError(f'{name}: action lies outside its bar: {pattern}')
            elif y2 > footer[1]:
                raise AssertionError(f'{name}: content lies below the action bar: {pattern}')
            observed.append({'pattern':pattern, 'bounds':bounds})
        for pattern in absent:
            if self.find(pattern, nodes) is not None:
                raise AssertionError(f'{name}: collapsed or inactive content is exposed: {pattern}')
        self.compact_ui_checks.append({'screen':name, 'webViewBounds':viewport,
                                       'actionBarBounds':footer, 'visibleTogether':observed,
                                       'absent':list(absent), 'helperScrolling':False})
        (self.output / 'compact-ui-checks.json').write_text(json.dumps(self.compact_ui_checks, indent=2))

    def edit_filters(self):
        self.wait_for_native_download_ui()
        self.click('^Edit filters$', timeout=20)
        self.await_text('date-preset-7', timeout=10)
        self.assert_compact_view('production-ui-edit-filters', [
            '^page-title$', '^date-preset-7$', '^file-types$', '^scan-button$', '^review-button$'
        ], ['^review-panel$', '^file-preview$'])

    def review_selection(self, name, files, routes, archive=False):
        self.await_text('Scan complete', timeout=30)
        if not archive:
            self.await_text(f'{files} files · {routes} ' + ('route' if routes == 1 else 'routes'), timeout=30)
        self.assert_compact_view(name, [
            '^page-title$', '^source-title$', '^edit-filters-button$', '^file-count$',
            '^route-count$', '^routes-disclosure$', '^action-summary$',
            '^save-button$' if archive else '^download-button$'
        ], ['^settings-form$', '^file-preview$'])

    def exercise_selection(self):
        self.click('^Open downloader UI$')
        self.await_text('Synthetic device', timeout=30)
        # The normal configuration and review actions deliberately do not use
        # automatic scrolling. Optional date/camera details are tested separately.
        self.click('^Recorded$', timeout=20)
        self.click('^Last 7$', timeout=20)
        today = datetime.date.fromisoformat(self.adb('shell', 'date', '+%Y-%m-%d', text=True).stdout.strip())
        first = today - datetime.timedelta(days=6)
        self.await_text(first.isoformat(), timeout=10)
        self.await_text(today.isoformat(), timeout=10)
        self.assert_compact_view('production-ui-source', [
            '^page-title$', '^source-title$', '^Recorded$', '^Uploaded$', '^date-preset-1$',
            '^date-preset-7$', '^date-preset-30$', '^date-preset-all$', '^date-preset-custom$',
            '^file-types$', '^camera-types$', '^scan-button$'
        ], ['^review-panel$', '^empty-results$', '^file-preview$', '^date-days$'])
        self.click('^Set days$', timeout=15)
        self.await_text('date-days', timeout=10)
        self.snapshot('production-ui-arbitrary-days')
        # Set days focuses a real numeric input. Dismiss an observed IME only;
        # blindly pressing Back could leave the extension if no keyboard opened.
        keyboard = self.adb('shell', 'dumpsys', 'input_method', text=True).stdout
        if re.search(r'(?:mInputShown|mIsInputViewShown)=true', keyboard):
            self.device.press('back')
        self.click('^Last 7$', timeout=15)
        self.click('^Custom$')
        self.await_text('From', timeout=10)
        self.await_text('Through', timeout=10)
        self.snapshot('production-ui-custom-dates')
        self.click('^Camera files', scroll=True)
        for camera in ('qcamera', 'fcamera', 'ecamera', 'dcamera'):
            self.await_text(camera, timeout=15, scroll=True)
        self.snapshot('production-ui-camera-options')
        self.page_top()
        self.click('^Camera files', scroll=True)
        self.page_top()
        self.click('^Today$')
        self.start_ui_scan()
        self.review_selection('production-ui-today', 2, 1)
        self.edit_filters()
        self.click('^Last 7$')
        self.start_ui_scan()
        self.review_selection('production-ui-populated', 6, 3)
        # Merely inspecting filters must preserve discovered files. Returning to
        # review must not issue another scan (which would alter this fixture).
        self.edit_filters()
        self.click('^Back to results$')
        self.review_selection('production-ui-results-preserved', 6, 3)
        self.click('^Prepare ZIP$', timeout=30)
        self.await_text('Save ZIP', timeout=30)
        self.review_selection('production-ui-zip-ready', 6, 3, archive=True)
        # The same round trip must retain an already prepared archive.
        self.edit_filters()
        self.click('^Back to results$')
        self.review_selection('production-ui-archive-preserved', 6, 3, archive=True)
        self.click('^Save ZIP$', timeout=20)
        recording = self.pull_zip('ui-recording')
        self.wait_for_native_download_ui()
        self.snapshot('production-ui-recording-saved')
        self.edit_filters()
        self.click('^Uploaded$', timeout=20)
        self.click('^Today$')
        self.start_ui_scan()
        self.review_selection('production-ui-upload-today', 2, 1)
        self.edit_filters()
        self.click('^Last 7$')
        self.start_ui_scan()
        self.review_selection('production-ui-upload-populated', 6, 3)
        self.click('^Prepare ZIP$', timeout=30)
        self.await_text('Save ZIP', timeout=30)
        self.click('^Save ZIP$', timeout=20)
        uploaded = self.pull_zip('ui-selection')
        self.wait_for_native_download_ui()
        self.snapshot('production-ui-saved')
        # The adapter deliberately corrects one upstream recording date between
        # distinct scan IDs. A fresh scan must discover that formerly excluded
        # route; no fixture data is persisted through extension preferences.
        self.edit_filters()
        self.click('^Recorded$', timeout=20)
        self.start_ui_scan()
        self.review_selection('production-ui-recording-rescan', 8, 4)
        return {'preset':'Last 7 days', 'fromDate':first.isoformat(), 'toDate':today.isoformat(),
                'matchedRoutes':3, 'savedFiles':6, 'todayMatchedRoutes':1,
                'recordingSelection':recording, 'uploadSelection':uploaded,
                'freshRecordingRescan':{'matchedRoutes':4, 'files':8,
                    'includedRouteIndices':[1,2,3,4],
                    'fixtureChange':'route index 2 recording date deliberately changed from 8 to 2 days ago between scans',
                    'validation':'production UI count after a fresh synthetic page read; live HTTP caching not tested'},
                'customDateControls':'visible; numerical ranges verified by local UI tests',
                'arbitraryDays':'Set days reveals the numerical input; preset hides it again',
                'compactUi':'default controls and collapsed review controls visible together without helper scrolling; bounds in compact-ui-checks.json',
                'editFilters':'returning without changes preserves both file results and prepared ZIP',
                'fileTypes':'rlog/qlog and four camera options displayed; rlog selection saved',
                'selectionDownload':'saved through native Firefox prompt; every path, byte and CRC verified'}

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
        selection = self.exercise_selection()
        (self.output / 'result.json').write_text(json.dumps({
            'status':'passed', 'archiveRuns':self.archive_results,
            'largestVerifiedPayloadMiB':60 if len(self.archive_results) == 3 else 30,
            'diskAbove32MiB':'passed' if len(self.archive_results) == 3 else 'not available; memory fallback',
            'smallZipFiles':120, 'mediumZipFiles':120,
            'smallPayloadMiB':7.5, 'mediumPayloadMiB':30,
            'cancellation':'passed', 'httpFailure':'passed',
            'productionUi':'synthetic API adapter; production HTML/CSS/handlers',
            'dateSelection':selection,
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
