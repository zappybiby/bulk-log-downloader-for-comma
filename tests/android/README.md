# Firefox Nightly Android verification

This test runs the archive engine inside a real Firefox Nightly extension on an Android emulator. It taps the save link, accepts Firefox's download prompt, pulls the resulting file from Android Downloads, then independently verifies ZIP CRCs, entry names and every byte with Python's standard ZIP implementation. The UI screenshots are actual emulator screenshots.

All routes, filenames and payloads are invented. No account, cookies, saved website pages or live comma downloads are involved. The fixture manifest explicitly disallows network requests. Never add private page captures, log URLs or account credentials to this directory or the workflow.

## What it exercises

- 120 files totaling 7.5 MiB, then 120 files totaling 30 MiB.
- A further 120-file, 60 MiB archive if Nightly reports OPFS temporary disk storage. The report explicitly records when the 32 MiB memory fallback prevents this case.
- Stream cancellation and rejection of an HTTP 503 without offering a successful partial archive.
- Production `downloads.html`, CSS, parser, parallel scanner and JavaScript interactions on a synthetic **device** page: Recorded and Uploaded date choices, Today and Last 7 days presets, custom-date controls, file scan, prepare ZIP and the native Save ZIP flow. Five routes have upload ages `[0, 2, 6, 8, 31]` days and recording ages `[20, 1, 8, 0, 6]` days; their timestamp route IDs are unrelated dates in 2020. Recorded Last 7 selects route indices `[1, 3, 4]`; Uploaded Last 7 selects `[0, 1, 2]`. Both selections have six rlogs, and both native ZIP saves are independently verified for every path, byte and CRC. Today matches one different route in each date mode. Explicit custom-date numerical ranges are covered by local UI tests; emulator evidence covers displaying those controls.
- Compact configure → review navigation: initial presets, date basis, log types and Scan action must be visible together without automatic scrolling. Review counts, Edit filters, collapsed route disclosure and Prepare/Save must also fit together. Each check records accessibility bounds relative to the actual WebView and footer in `compact-ui-checks.json`; hidden panels and collapsed route contents must not appear in the hierarchy. Optional custom-date and camera details may require scrolling.
- Editing filters and returning without changes preserves discovered files and a prepared ZIP; changing a filter still triggers fresh selection. The Set days action reveals arbitrary-day input.
- A second Recorded Last 7 scan after a deliberate synthetic upstream correction: route index 2 changes from 8 to 2 recording days ago between scan IDs. The production UI must then report four routes. This proves fresh synthetic page reading, not behavior of real HTTP caches or the live server. Preferences contain choices, not route-date metadata.
- Explicit synthetic page reads wait 20 ms asynchronously so the production request pool can overlap them. This small UI test is not a network speed benchmark or a substitute for scanner concurrency/failure tests. The production scanner's separate local tests verify the bounded request pool.
- A test-only adapter supplies parser-generated synthetic pages and synthetic fetch results at the browser API boundary; the production distributable never contains this adapter.
- Exact Firefox package/version, Android version, archive storage mode, sizes, timing, SHA-256 hashes, screenshots, UI XML, web-ext logs, Android crash logs and process memory snapshot.

The production UI adapter does **not** validate real site authentication, source-tab messaging, signed-URL expiry, or real account access. The emulator run also does not establish safe limits for multi-gigabyte archives, all phone hardware, background operation or screen-off behavior.

## Run in GitHub Actions

Run **Firefox Nightly Android synthetic test** from the Actions tab. Pushes to `firefox-android` or `codex/firefox-android*` and matching pull-request changes also run it. Download the `firefox-nightly-android-results` artifact to inspect results. A run only passes after saved ZIPs are pulled from Android and independently verified; screenshots alone do not establish success.

The workflow uses an Android 15 / API 35 x86_64 Pixel emulator and KVM on Ubuntu. Nightly is resolved from Mozilla's current signed build index, `gecko.v2.mozilla-central.latest.mobile.fenix-nightly`. The downloader checks the task is `signing-apk-fenix-nightly`, selects its x86_64 APK, and records its exact task ID and SHA-256. This corrects the obsolete `mobile.v2.fenix.nightly.latest.x86_64` link still present in older Mozilla documentation.

## Run on a disposable local emulator

Requirements: Node 22+, Python 3.12+, Android SDK / adb, and a fresh English-language x86_64 Android emulator. This setup navigates onboarding and enables Firefox's remote debugging setting on that disposable instance.

```sh
npm ci
python -m pip install 'uiautomator2==3.5.0'
node tests/android/stage.mjs
python tests/android/download-nightly.py android-results/nightly.apk
adb install -r android-results/nightly.apk
python tests/android/run.py --serial emulator-5554
```

The test extension is temporarily installed by Mozilla's `web-ext`; it is never published or signed. The staged directory is `.android-selftest`, separate from the distributable Firefox extension. Nightly changes frequently; if its onboarding or settings controls change, the run fails and leaves a screenshot plus UI tree for repairing the automation.

## Primary references

- [Mozilla's Android extension development guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)
- [Mozilla web-ext command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [Mozilla current Nightly index](https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-central.latest.mobile.fenix-nightly)
- [Android Emulator Runner](https://github.com/ReactiveCircus/android-emulator-runner)
- [uiautomator2](https://github.com/openatx/uiautomator2)
