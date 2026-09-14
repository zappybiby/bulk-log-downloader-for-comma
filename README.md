Unofficial Chrome extension for useradmin.comma.ai that downloads logs in bulk.

A separate [Firefox Android prototype](firefox/README.md) is available in `firefox/`.
Version 0.4 adds a compact choose → review → save flow, with expandable options
and route details. It retains recording/upload date filters, four fresh parallel
page readers without a metadata cache, all six log/camera choices, and ZIP output.

[Download unsigned v0.4.0](docs/downloads/comma-firefox-0.4.0-unsigned.zip) ·
[Compact UI and verification](docs/firefox-compact-ui.md) ·
[Parallel reading](docs/firefox-parallel-reading.md)

Normal installation requires Mozilla signing. See the Firefox README for
temporary development installation and the prototype's limits.

[Recording-date performance experiments](docs/recording-date-performance.md) compare
parallel discovery, caching and a possible bulk metadata source for larger collections.
The current implementation uses fresh parallel reads; caching remains an experiment.

[Further recording-date investigation](docs/recording-date-investigation.md) includes
real Firefox Android parsing measurements and additional discovery prototypes.
