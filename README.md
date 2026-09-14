Unofficial Chrome extension for useradmin.comma.ai that downloads logs in bulk.

A separate [Firefox Android prototype](firefox/README.md) is available in `firefox/`.
Version 0.4 adds a compact choose → review → save flow, with expandable options
and route details. It retains recording/upload date filters, four fresh parallel
page readers without a metadata cache, all six log/camera choices, and ZIP output.

[Download unsigned v0.4.0 XPI](docs/downloads/comma-firefox-0.4.0-unsigned.xpi) ·
[ZIP package](docs/downloads/comma-firefox-0.4.0-unsigned.zip) ·
[Compact UI and verification](docs/firefox-compact-ui.md) ·
[Parallel reading](docs/firefox-parallel-reading.md)

The XPI contains exactly the same tested files as the ZIP and is still unsigned.
For local testing in Android Nightly, set `xpinstall.signatures.required` to
`false` in `about:config`. In Settings → About Firefox Nightly, tap the logo five
times, then return to Settings → Install Extension from File and select the XPI.
This preference disables signature checks for all extensions in Nightly.
See Mozilla's [Nightly signing exception](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and [Android file installation instructions](https://extensionworkshop.com/documentation/publish/install-self-distributed/#install-add-on-from-file-on-android).
The local-file installation path is documented here; the recorded emulator tests
used temporary developer loading.

Normal installation requires Mozilla signing. See the Firefox README for
temporary development installation and the prototype's limits.

[Recording-date performance experiments](docs/recording-date-performance.md) compare
parallel discovery, caching and a possible bulk metadata source for larger collections.
The current implementation uses fresh parallel reads; caching remains an experiment.

[Further recording-date investigation](docs/recording-date-investigation.md) includes
real Firefox Android parsing measurements and additional discovery prototypes.
