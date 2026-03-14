# AFL-MCP Data Extraction Script
# Extracts AFL data from the fitzRoy R package and exports to CSV.
#
# Usage: Rscript etl/extract.R
#
# Prerequisites:
#   install.packages("fitzRoy")
#   install.packages("readr")
#
# Output: data/raw/{results.csv, player_stats.csv, players.csv}

library(fitzRoy)
library(readr)

# Configuration
SEASONS <- 2016:2025
COMP <- "AFLM"
OUTPUT_DIR <- file.path("data", "raw")

# Ensure output directory exists
dir.create(OUTPUT_DIR, recursive = TRUE, showWarnings = FALSE)

cat("=== AFL-MCP Data Extraction ===\n\n")

# 1. Match results from afltables
cat("Fetching match results (afltables)...\n")
results <- fetch_results(season = SEASONS, source = "afltables", comp = COMP)
results_path <- file.path(OUTPUT_DIR, "results.csv")
write_csv(results, results_path)
cat(sprintf("  Written %d rows to %s\n\n", nrow(results), results_path))

# 2. Player match stats from fryzigg
cat("Fetching player stats (fryzigg)...\n")
player_stats <- fetch_player_stats(season = SEASONS, source = "fryzigg", comp = COMP)
stats_path <- file.path(OUTPUT_DIR, "player_stats.csv")
write_csv(player_stats, stats_path)
cat(sprintf("  Written %d rows to %s\n\n", nrow(player_stats), stats_path))

# 3. Player details from afltables
cat("Fetching player details (afltables)...\n")
players <- fetch_player_details(season = SEASONS, source = "afltables", comp = COMP)
players_path <- file.path(OUTPUT_DIR, "players.csv")
write_csv(players, players_path)
cat(sprintf("  Written %d rows to %s\n\n", nrow(players), players_path))

cat("=== Extraction complete ===\n")
