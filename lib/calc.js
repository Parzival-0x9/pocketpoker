export function round2(n){ return Math.round((Number(n)||0)*100)/100; }
export function sum(arr){ return round2(arr.reduce((a,b)=>a+(Number(b)||0),0)); }
export function aud(n){ return 'A$'+round2(n).toFixed(2); }

// Greedy settlement: match debtors to creditors
export function settle(entries){
  const debtors = [], creditors = [];
  (entries||[]).forEach(e=>{
    const net = round2(e.net||0);
    if(net < 0) debtors.push({name:e.name, amt:-net});
    else if(net > 0) creditors.push({name:e.name, amt:net});
  });
  debtors.sort((a,b)=>b.amt-a.amt);
  creditors.sort((a,b)=>b.amt-a.amt);
  const txns = [];
  let i=0,j=0;
  while(i<debtors.length && j<creditors.length){
    const d=debtors[i], c=creditors[j];
    const pay = round2(Math.min(d.amt, c.amt));
    if(pay>0){
      txns.push({ from:d.name, to:c.name, amount: pay });
      d.amt = round2(d.amt - pay);
      c.amt = round2(c.amt - pay);
    }
    if(d.amt<=0.001) i++;
    if(c.amt<=0.001) j++;
  }
  return txns;
}

// Next Friday 17:00 local (or from given ISO date string)
export function nextFridayISO(fromISO){
  const d = fromISO ? new Date(fromISO) : new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const add = (5 - day + 7) % 7 || 7; // next Friday (not today if Friday)
  const n = new Date(d.getFullYear(), d.getMonth(), d.getDate()+add, 17, 0, 0, 0);
  return n.toISOString();
}

// CSV
function esc(v){
  const s = String(v ?? '');
  if (/[",
]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}
export function toCSV(rows){
  return (rows||[]).map(r => (r||[]).map(esc).join(",")).join("\n");
}
