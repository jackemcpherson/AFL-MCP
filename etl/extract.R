# AFL-MCP Data Extraction Script
# Extracts AFL data from the fitzRoy R package and exports to CSV.
#
# Multi-source priority:
#   1. AFL official API — primary for results + player stats (fastest updates)
#   2. FootyWire — fallback for results if AFL API is missing recent matches
#   3. Fryzigg — enrichment-only pass adding advanced columns
#   4. afltables — fallback for historical seasons
#
# Usage:
#   Rscript etl/extract.R          # Full extract (1990–current year)
#   Rscript etl/extract.R 2026     # Single season extract
#
# Output: data/raw/{results_afl.csv, results_footywire.csv, player_stats_afl.csv,
#                    player_stats_fryzigg.csv, players.csv}
#         Legacy fallback also produces results.csv / player_stats.csv

library(fitzRoy)
library(readr)

# Configuration
args <- commandArgs(trailingOnly = TRUE)
if (length(args) > 0) {
  SEASONS <- as.integer(args[1])
  cat(sprintf("Single-season mode: %d\n", SEASONS))
} else {
  SEASONS <- 1990:as.integer(format(Sys.Date(), "%Y"))
  cat(sprintf("Full extract: %d–%d\n", min(SEASONS), max(SEASONS)))
}
COMP <- "AFLM"
OUTPUT_DIR <- file.path("data", "raw")

# Ensure output directory exists
dir.create(OUTPUT_DIR, recursive = TRUE, showWarnings = FALSE)

cat("=== AFL-MCP Data Extraction ===\n\n")

# Determine if we're fetching current/recent seasons (AFL API available)
# or historical seasons (fall back to afltables)
is_current <- all(SEASONS >= 2020)

if (is_current) {
  # --- Primary: AFL API results ---
  cat("Fetching match results (AFL API)...\n")
  afl_results <- tryCatch({
    res <- fetch_results(season = SEASONS, source = "AFL", comp = COMP)

    # Flatten nested periodScore columns into per-quarter columns
    for (i in seq_len(nrow(res))) {
      for (side in c("home", "away")) {
        ps_col <- paste0(side, "TeamScore.periodScore")
        ps <- res[[ps_col]][[i]]
        if (is.data.frame(ps)) {
          for (q in 1:4) {
            if (q <= nrow(ps)) {
              res[[paste0(side, "_q", q, "_goals")]][i] <- ps$score.goals[q]
              res[[paste0(side, "_q", q, "_behinds")]][i] <- ps$score.behinds[q]
            }
          }
        }
      }
    }
    # Drop nested list-columns that write_csv cannot serialise
    res <- res[, !sapply(res, is.list)]

    results_path <- file.path(OUTPUT_DIR, "results_afl.csv")
    write_csv(res, results_path)
    cat(sprintf("  Written %d rows to %s\n\n", nrow(res), results_path))
    res
  }, error = function(e) {
    cat(sprintf("  AFL API results failed: %s\n\n", e$message))
    NULL
  })

  # --- Fallback: FootyWire results (if AFL API missing recent matches) ---
  needs_footywire <- FALSE
  if (is.null(afl_results)) {
    needs_footywire <- TRUE
  } else {
    # Check if AFL results cover recent matches (within 3 days)
    max_date <- tryCatch({
      as.Date(max(afl_results$match.date, na.rm = TRUE))
    }, error = function(e) as.Date("2000-01-01"))
    if (Sys.Date() - max_date > 3) {
      needs_footywire <- TRUE
    }
  }

  if (needs_footywire) {
    cat("Fetching match results (FootyWire fallback)...\n")
    tryCatch({
      fw_results <- fetch_results(season = SEASONS, source = "footywire", comp = COMP)
      fw_path <- file.path(OUTPUT_DIR, "results_footywire.csv")
      write_csv(fw_results, fw_path)
      cat(sprintf("  Written %d rows to %s\n\n", nrow(fw_results), fw_path))
    }, error = function(e) {
      cat(sprintf("  FootyWire results failed: %s\n\n", e$message))
    })
  }

  # --- Primary: AFL API player stats ---
  cat("Fetching player stats (AFL API)...\n")
  tryCatch({
    afl_stats <- fetch_player_stats(season = SEASONS, source = "AFL", comp = COMP)
    stats_path <- file.path(OUTPUT_DIR, "player_stats_afl.csv")
    write_csv(afl_stats, stats_path)
    cat(sprintf("  Written %d rows to %s\n\n", nrow(afl_stats), stats_path))
  }, error = function(e) {
    cat(sprintf("  AFL API player stats failed: %s\n\n", e$message))
  })

  # --- Enrichment: Fryzigg player stats (advanced columns) ---
  cat("Fetching player stats (fryzigg enrichment)...\n")
  tryCatch({
    fryzigg_stats <- fetch_player_stats(season = SEASONS, source = "fryzigg", comp = COMP)
    fryzigg_path <- file.path(OUTPUT_DIR, "player_stats_fryzigg.csv")
    write_csv(fryzigg_stats, fryzigg_path)
    cat(sprintf("  Written %d rows to %s\n\n", nrow(fryzigg_stats), fryzigg_path))
  }, error = function(e) {
    cat(sprintf("  Fryzigg stats failed: %s\n\n", e$message))
  })

} else {
  # --- Historical: afltables for results, fryzigg for stats (legacy path) ---
  cat("Fetching match results (afltables)...\n")
  results <- fetch_results(season = SEASONS, source = "afltables", comp = COMP)
  results_path <- file.path(OUTPUT_DIR, "results.csv")
  write_csv(results, results_path)
  cat(sprintf("  Written %d rows to %s\n\n", nrow(results), results_path))

  cat("Fetching player stats (fryzigg)...\n")
  player_stats <- fetch_player_stats(season = SEASONS, source = "fryzigg", comp = COMP)
  stats_path <- file.path(OUTPUT_DIR, "player_stats.csv")
  write_csv(player_stats, stats_path)
  cat(sprintf("  Written %d rows to %s\n\n", nrow(player_stats), stats_path))
}

# Player details always from afltables (optional — not used by Python loader)
cat("Fetching player details (afltables)...\n")
tryCatch({
  players <- fetch_player_details(season = SEASONS, source = "afltables", comp = COMP)
  players_path <- file.path(OUTPUT_DIR, "players.csv")
  write_csv(players, players_path)
  cat(sprintf("  Written %d rows to %s\n\n", nrow(players), players_path))
}, error = function(e) {
  cat(sprintf("  Player details failed (non-fatal): %s\n\n", e$message))
})

cat("=== Extraction complete ===\n")
