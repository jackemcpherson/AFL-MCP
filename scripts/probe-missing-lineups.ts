import { fetchLineup } from "fitzroy";

async function probe(year: number, round: number) {
  console.log(`\n=== ${year} R${round} (afl-api) ===`);
  const r = await fetchLineup({ source: "afl-api", season: year, round, competition: "AFLM" });
  if (!r.success) {
    console.log(`  FAILED: ${r.error.message}`);
    return;
  }
  console.log(`  ${r.data.length} matches`);
  for (const lineup of r.data) {
    const home = lineup.homePlayers.length;
    const away = lineup.awayPlayers.length;
    console.log(
      `    ${lineup.homeTeam} vs ${lineup.awayTeam}: home=${home} away=${away} matchId=${lineup.matchId}`,
    );
  }
}

async function main() {
  // The known missing rounds from the data quality review.
  await probe(2015, 4);
  await probe(2017, 8);
  await probe(2018, 9);
  await probe(2019, 11);
  // 2015 GF — finals lineups via fetchLineup require the finals round number.
  // Round 27 is the AFL convention for GF in a 23-round + 4-week-finals season.
  for (const r of [24, 25, 26, 27]) await probe(2015, r);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
