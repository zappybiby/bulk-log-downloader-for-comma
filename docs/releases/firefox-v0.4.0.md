Experimental bulk-log downloader for **Firefox Nightly on Android**. Download
**comma-firefox-0.4.0-unsigned.xpi** from Assets below.

- Compact setup and review screens with the next action in the bottom bar.
- Filter by **recording date or upload date**, with recent days and custom ranges.
- Four parallel page readers, fresh scans without a recording-date cache, and ZIP output.
- Optional camera files and expandable route details.

### Install on Nightly

1. Download the `.xpi` asset; no renaming or extraction is needed.
2. Open `about:config` and set `xpinstall.signatures.required` to `false`.
3. In **Settings → About Firefox Nightly**, quickly tap the Firefox logo five times.
4. Return to **Settings → Install Extension from File**, select the XPI, and approve installation.
5. Sign in to useradmin.comma.ai, open a device or route page, then launch **Comma Bulk Logs for Firefox** from Extensions.

This build is **unsigned**. The Nightly preference disables signature checks for
all extensions, so install only trusted files. Standard Firefox installation
requires Mozilla signing.
[Mozilla signing information](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) ·
[Android file installation](https://extensionworkshop.com/documentation/publish/install-self-distributed/#install-add-on-from-file-on-android)

### Verification and limits

87 automated tests and Firefox lint passed. [Firefox Nightly Android testing](https://github.com/zappybiby/bulk-log-downloader-for-comma/actions/runs/34899885851)
verified synthetic recording/upload selections, native saves, Edit/Back retention,
fresh recording-date rescans, cancellation, HTTP failure, and 120-file ZIPs up to
60 MiB. Tests used temporary developer loading; the local-file installation steps
above follow Mozilla's documentation.

Live account access and background downloading remain untested. Keep the downloader
in the foreground. Archive limits are 256 MiB with temporary disk storage or
32 MiB with the memory fallback. Private page captures are excluded from this
release, its source, and remote tests.

[Usage and limits](https://github.com/zappybiby/bulk-log-downloader-for-comma/blob/firefox-v0.4.0/firefox/README.md) ·
[Screenshots and evidence](https://github.com/zappybiby/bulk-log-downloader-for-comma/blob/firefox-v0.4.0/docs/firefox-compact-ui.md)

XPI SHA-256: `5f1bca3d0ba6b1902d2fb454b9052ae515c87dd663881fc0121b37d43dd29893`
