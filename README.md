Unofficial Chrome extension for useradmin.comma.ai that downloads logs in bulk.

A separate [Firefox Android prototype](firefox/README.md) is available in `firefox/`.
Version 0.3 adds recording-date filtering and four parallel page readers, with
fresh dates on every scan and no metadata cache. It also supports upload-date
filters, all six log/camera choices, grouped route results and ZIP output.

[Download unsigned v0.3.0](docs/downloads/comma-firefox-0.3.0-unsigned.zip) ·
[Parallel reading and Android verification](docs/firefox-parallel-reading.md)

Normal installation requires Mozilla signing. See the Firefox README for
temporary development installation and the prototype's limits.

[Recording-date performance experiments](docs/recording-date-performance.md) compare
parallel discovery, caching and a possible bulk metadata source for larger collections.
The current implementation uses fresh parallel reads; caching remains an experiment.

[Further recording-date investigation](docs/recording-date-investigation.md) includes
real Firefox Android parsing measurements and additional discovery prototypes.
