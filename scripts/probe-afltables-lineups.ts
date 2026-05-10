import { fetchLineup } from "fitzroy";

async function probe(year: number, round: number) {
  console.log(`\n=== ${year} R${round} (afl-tables) ===`);
  const r = await fetchLineup({ source: "afl-tables", season: year, round, competition: "AFLM" });
  if (!r.success) {
    console.log(`  FAILED: ${r.error.message}`);
    return;
  }
  console.log(`  ${r.data.length} matches`);
  const first = r.data[0];
  if (first) {
    console.log(
      `    first: ${first.homeTeam} (${first.homePlayers.length}p) vs ${first.awayTeam} (${first.awayPlayers.length}p)`,
    );
    console.log(`    sample player: ${JSON.stringify(first.homePlayers[0], null, 2)}`);
  }
}

async function main() {
  // Sample rounds across the years we can't fix and the years where fitzroy fails on afl-api.
  await probe(2021, 1);
  await probe(2022, 1);
  await probe(2015, 4); // fitzroy afl-api fails here
  await probe(2017, 8);
  await probe(2018, 9);
  await probe(2019, 11);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
