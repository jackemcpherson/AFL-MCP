# ETL - Data Extraction

## Prerequisites

Install R and the required packages:

```r
install.packages(c("fitzRoy", "readr"))
```

## Running

From the project root:

```bash
Rscript etl/extract.R
```

This will create CSV files in `data/raw/`:

- `results.csv` — Match results from afltables (2016-2025)
- `player_stats.csv` — Per-match player statistics from fryzigg (2016-2025)
- `players.csv` — Player biographical details from afltables (2016-2025)

The script is idempotent — re-running will overwrite the CSV files with fresh data.
