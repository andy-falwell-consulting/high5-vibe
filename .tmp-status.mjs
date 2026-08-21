// READ-ONLY. Exact counts per status, so removing a value from the list is a
// decision about real records rather than a tidy-up.
import { fmpToken } from './api/_fmp.js';
const DB='High5_Core4', LAYOUT='trainings_New', HOST='https://ILELLCO.pcifmhosting.com';
const token = await fmpToken(DB);
let offset=1, n=0; const all=new Map();
for(;;){
  const r=await fetch(`${HOST}/fmi/data/v2/databases/${DB}/layouts/${LAYOUT}/records?_offset=${offset}&_limit=500`,
    {headers:{Authorization:`Bearer ${token}`}});
  const j=await r.json().catch(()=>({})); const d=j?.response?.data||[];
  if(!d.length) break;
  for(const rec of d){ const s=String(rec.fieldData?.Status??'').trim()||'(blank)';
    all.set(s,(all.get(s)||0)+1); }
  n+=d.length; offset+=d.length; if(d.length<500) break;
}
const NEW = ['Inquiry','Follow-up Needed','Proposed','Approved/Needs to be D-Invoiced & TC',
  'Waiting on $ & Signed TC','Confirmed/Scheduled','Completed','Final Invoiced','No Go','Out Reach','Other'];
console.log(`${n} trainings\n`);
console.log('IN THE NEW LIST');
for(const s of NEW) console.log(`  ${String(all.get(s)??0).padStart(5)}  ${s}`);
console.log('\nNOT IN THE NEW LIST — records that carry it anyway');
let orphan=0;
for(const [s,c] of [...all.entries()].sort((a,b)=>b[1]-a[1]))
  if(!NEW.includes(s)){ orphan+=c; console.log(`  ${String(c).padStart(5)}  ${JSON.stringify(s)}`); }
console.log(`\n  ${orphan} records would have a status the list no longer offers`);
