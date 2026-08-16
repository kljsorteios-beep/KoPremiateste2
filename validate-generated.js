#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const outputDir = path.resolve(process.argv[2] || 'generated-raffle');
const winners = fs.readFileSync(path.join(outputDir, 'numeros-premiados.csv'), 'utf8').trim().split(/\n/);
const all = fs.readFileSync(path.join(outputDir, 'ordem-distribuicao.csv'), 'utf8').trim().split(/\n/);
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
  result.winners !== 10000
  || result.allNumbers !== 150000
  || result.uniqueWinners !== 10000
  || result.uniqueAll !== 150000
  || !result.winnersSubsetOfAll
) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
