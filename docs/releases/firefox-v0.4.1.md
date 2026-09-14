**Less text, the same download flow.** This patch removes the repeated explanatory
copy from the Firefox Android interface.

- Removed the general Storage & help section and camera-size advice.
- Removed repeated instructions to keep tabs open and check Firefox Downloads.
- Replaced the save message with **Save requested**.
- Removed file-size explanations, page-read totals, and routine date-filter exclusion counts.
- Route details show a simple count instead of explaining what the ZIP includes.

File counts, dates, progress, actual errors, and unreadable-date notices remain.
The 32 MiB limit appears only when the memory fallback is in use. Recording/upload
filters, four fresh parallel readers, archive limits, and ZIP contents are unchanged.

### Install or update

Download **comma-firefox-0.4.1-unsigned.xpi** from Assets and select it in Nightly's
**Settings → Install Extension from File**. It uses the same extension ID as v0.4.0.

For first installation: set `xpinstall.signatures.required` to `false` in
`about:config`, then tap the logo five times in **Settings → About Firefox Nightly**
to reveal the file installer. The build is unsigned; the setting disables signature
checks for all Nightly extensions.
[Mozilla instructions](https://extensionworkshop.com/documentation/publish/install-self-distributed/#install-add-on-from-file-on-android)

### Verification

32 UI checks passed, including filter selection, Edit/Back retention, repeated
Save requests, and error/cancellation handling. Firefox lint reported zero errors,
warnings, or notices. [Small-screen layout checks passed](https://github.com/zappybiby/bulk-log-downloader-for-comma/actions/runs/34901919503)
at 320, 360, and 390 pixel widths, including a doubled-text stress check. These
renders use invented logs; private captures are excluded from releases and remote
tests. Live account access remains untested.

XPI SHA-256: `eae229c220f4ae420f75030f686ab57c919225f54cfbf416fb945768d9fa9eb2`
