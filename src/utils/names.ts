// Docker-style random container names (adjective_surname); Apple container otherwise falls back to a UUID

const ADJECTIVES = [
  'agile', 'bold', 'brave', 'bright', 'calm', 'clever', 'cool', 'curious', 'daring', 'eager',
  'epic', 'fervent', 'focused', 'gentle', 'happy', 'humble', 'jolly', 'keen', 'kind', 'lucid',
  'lively', 'loyal', 'merry', 'mighty', 'modest', 'nimble', 'noble', 'patient', 'peaceful', 'quick',
  'quiet', 'relaxed', 'serene', 'sharp', 'steady', 'sunny', 'swift', 'tender', 'tidy', 'vibrant',
  'vivid', 'warm', 'wise', 'witty', 'zealous',
];

/** Scientists and engineers, as in Docker's generator */
const SURNAMES = [
  'babbage', 'bohr', 'curie', 'darwin', 'dijkstra', 'einstein', 'euler', 'faraday', 'fermi', 'feynman',
  'franklin', 'galileo', 'gauss', 'goodall', 'hamilton', 'hawking', 'hertz', 'hopper', 'hypatia', 'johnson',
  'kepler', 'knuth', 'lamarr', 'lovelace', 'maxwell', 'meitner', 'mendel', 'newton', 'noether', 'pascal',
  'pasteur', 'planck', 'ritchie', 'sagan', 'shannon', 'tesla', 'thompson', 'torvalds', 'turing', 'volta',
  'wozniak', 'wright', 'yalow', 'yonath', 'zuse',
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** Returns a name not in taken; after a few collisions a number is appended, like Docker does */
export function generateContainerName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let attempt = 0; ; attempt++) {
    const base = `${pick(ADJECTIVES, random)}_${pick(SURNAMES, random)}`;
    const name = attempt < 10 ? base : `${base}${attempt - 9}`;
    if (!taken.has(name)) {
      return name;
    }
  }
}
