const fs = require('node:fs');
const path = require('node:path');

const outputDir = path.resolve(process.argv[2] || 'generated-raffle');
const expectedWinnersArg = process.argv.find((arg) => arg.startsWith('--expected-winners='));
const expectedWinners = expectedWinnersArg ? Number(expectedWinnersArg.split('=')[1]) : 0;
const winnersText = fs.readFileSync(path.join(outputDir, 'numeros-premiados.csv'), 'utf8').trim();
const allText = fs.readFileSync(path.join(outputDir, 'ordem-distribuicao.csv'), 'utf8').trim();
const winners = winnersText ? winnersText.split(/\r?\n/) : [];
const all = allText ? allText.split(/\r?\n/) : [];
const winnerSet = new Set(winners);
const allSet = new Set(all);
const result = {
  winners: winners.length,
  allNumbers: all.length,
  uniqueWinners: winnerSet.size,
  uniqueAll: allSet.size,
  winnersSubsetOfAll: winners.every((number) => allSet.has(number)),
};

if (
  !Number.isInteger(expectedWinners)
  || expectedWinners < 0
  || result.winners !== expectedWinners
  || result.uniqueWinners !== expectedWinners
  || result.allNumbers !== 150000
  || result.uniqueAll !== 150000
  || !result.winnersSubsetOfAll
) {
  console.error(JSON.stringify({ ...result, expectedWinners }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ...result, expectedWinners }, null, 2));
