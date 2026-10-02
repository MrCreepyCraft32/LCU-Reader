const fs = require('fs');
const path = require('path');
const { decode } = require('./src/lcuDecoder');

const dir = "C:\\Users\\piete\\Pictures\\Rock'n'Roller Coaster avec Aerosmith 1\\Rock_n_Roller Coaster avec Aerosmith\\Programmes\\LCU Soundtracker";
const files = ['saddle1h.lcu', 'lust2h.lcu', 'walk3h.lcu', '9lives4h.lcu', 'emoton5h.lcu'];

let failures = 0;

files.forEach(f => {
  const p = path.join(dir, f);
  const content = fs.readFileSync(p, 'latin1');
  const d = decode(content, f);
  const ok = d.sequences.length > 0 && d.waves.length > 0 && d.version === 10 && d.equalizerProfiles.length > 0;
  if (!ok) failures++;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${f}`);
  console.log(`  title=${d.metadata.title} | ver=${d.version} | waves=${d.waves.length} | phrases=${Object.keys(d.phrases).length} | seq=${d.sequences.length} | triggers=${d.triggers.length} | eq=${d.equalizer.length} | eqProfiles=${d.equalizerProfiles.map(p => p.index + '(' + p.banks.length + 'b)').join(',')} | sections=${Object.keys(d.rawSections).join(',')}`);
});

console.log(failures === 0 ? 'All 5 files decoded successfully.' : `${failures} file(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);