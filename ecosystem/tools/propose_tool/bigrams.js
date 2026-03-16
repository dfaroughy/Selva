// Jungle-themed bigram generator for tool/session IDs

const JUNGLE_A = [
  'Panthera',      // jaguar, tiger, leopard
  'Leopardus',     // ocelot
  'Tapirus',       // tapir
  'Boa',           // boa constrictor
  'Eunectes',      // anaconda
  'Harpia',        // harpy eagle
  'Ara',           // scarlet macaw
  'Agalychnis',    // red-eyed tree frog
  'Pongo',         // orangutan
  'Okapia',        // okapi
  'Gorilla',       // gorilla
  'Ceiba',         // kapok tree
  'Victoria',      // giant amazon waterlily
  'Hevea',         // rubber tree
  'Theobroma',     // cacao
  'Vanilla',       // vanilla orchid
  'Monstera',      // tropical liana
  'Ficus',         // rubber fig
  'Heliconia',     // lobster-claw
  'Philodendron',  // jungle aroid
  'Anthurium',     // tropical epiphyte
  'Calathea',      // prayer-plant relative
  'Dieffenbachia', // tropical aroid
  'Alpinia',       // red ginger
  'Musa',          // wild banana
];

const JUNGLE_B = [
  'Onca',
  'Pardalis',
  'Terrestris',
  'Constrictor',
  'Murinus',
  'Harpyja',
  'Macao',
  'Callidryas',
  'Pygmaeus',
  'Johnstoni',
  'Gorilla',
  'Pentandra',
  'Amazonica',
  'Brasiliensis',
  'Cacao',
  'Planifolia',
  'Deliciosa',
  'Elastica',
  'Rostrata',
  'Gloriosum',
  'Veitchii',
  'Lutea',
  'Seguine',
  'Purpurata',
  'Acuminata',
];

function jungleBigram(hashHex) {
  // Use first 4 hex chars to pick deterministic bigram
  const a = parseInt(hashHex.slice(0, 2), 16) % JUNGLE_A.length;
  const b = parseInt(hashHex.slice(2, 4), 16) % JUNGLE_B.length;
  const short = hashHex.slice(0, 8);
  return JUNGLE_A[a] + JUNGLE_B[b] + '_' + short;
}

module.exports = { jungleBigram, JUNGLE_A, JUNGLE_B };
