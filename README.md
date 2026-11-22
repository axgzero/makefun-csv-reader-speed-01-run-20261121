# makefun-csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/axgzero/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/axgzero/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast, dependency-free CSV reader that reproduces csv-reader 1.0.0 exactly — same columns, rows and broken-row errors (stray CRs, unterminated quotes, quote junk, short and long rows) — by locating fields with indexOf and cutting them out with slice instead of reading one character at a time.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cefc1nk2&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
