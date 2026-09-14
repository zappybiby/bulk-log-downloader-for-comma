# Firefox Android prototype: validation record

The Firefox extension uses a full browser tab to collect rlogs and qlogs into a
ZIP. It is an unsigned prototype. See the [setup guide](../firefox/README.md) for
temporary development installation and Mozilla signing requirements.

## Environment and evidence

The Android test uses Firefox Nightly **158.0a1** on an Android **15 / API 35**
x86_64 emulator. It temporarily installs a test extension containing the
production archive engine and production downloader HTML, CSS and handlers.
All routes and file contents in that environment are invented. Uploaded page
captures were inspected locally and are absent from the repository, test
fixtures, CI and packages.

The test source is commit
`c7e37a921fcd56a56b5f05f3ce04a0aaab3cc46c`.
[The passing Actions run](https://github.com/zappybiby/bulk-log-downloader-for-comma/actions/runs/34848694066)
contains the execution status and downloadable synthetic evidence. All checks
listed below passed in that run.

## Checks

| Payload | Files | Storage | Verification |
| --- | ---: | --- | --- |
| 7.5 MiB | 120 | Browser temporary disk (OPFS) | Native save, then every entry, byte and CRC checked |
| 30 MiB | 120 | Browser temporary disk (OPFS) | Native save, then every entry, byte and CRC checked |
| 60 MiB | 120 | Browser temporary disk (OPFS) | Native save, then every entry, byte and CRC checked |

The automation taps Firefox's download prompt, pulls each ZIP from Android
Downloads using adb, and verifies it with Python's independent ZIP reader.
Additional checks exercise cancellation, an HTTP 503 response and the
production downloader's scan, prepare and visible save controls. Emulator
screenshots show the actual interface. An observed scroll trap in the file
preview was fixed so swipes can reach the save controls below it.

The local suite contains 36 parser, bridge, archive and UI tests. Extension
linting reports no errors, warnings or notices. The packaging script includes
only an explicit list of production files and documentation.

## What this establishes

Firefox Nightly on Android can build these multi-file ZIPs using temporary disk
storage and save them through its native download flow. The mobile interface
can scan and prepare a synthetic selection.

Live account authentication, live signed download URLs, background operation,
screen-off behavior and other phone hardware have not been tested. The 256 MiB
default archive limit is a protective ceiling, not a verified capacity on every
phone; the largest verified payload is 60 MiB. Browser temporary storage can
fall back to a 32 MiB memory limit. Existing compressed logs are stored in the
ZIP without recompression.

The [test instructions](../tests/android/README.md) describe reproduction and
the boundary between production code and the synthetic browser API adapter.
