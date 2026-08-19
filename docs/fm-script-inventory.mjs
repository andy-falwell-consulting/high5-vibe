import { fmpToken } from '../api/_fmp.js';
const HOST = 'https://ILELLCO.pcifmhosting.com';
const db = 'High5_Core4';
const t = await fmpToken(db);
const r = await fetch(`${HOST}/fmi/data/v2/databases/${db}/scripts`,
  { headers: { Authorization: `Bearer ${t}` } });
const j = await r.json();
const flat = [];
(function walk(list, path='') {
  for (const s of list || []) {
    if (s.isFolder) walk(s.folderScriptNames, path + s.name + ' / ');
    else flat.push(path + s.name);
  }
})(j?.response?.scripts);
console.log('TOTAL SCRIPTS:', flat.length);
console.log(flat.join('\n'));
// be tidy: release the session
await fetch(`${HOST}/fmi/data/v2/databases/${db}/sessions/${t}`, { method: 'DELETE' });
