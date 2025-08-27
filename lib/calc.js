
export const round2 = (n)=> Math.round((n + Number.EPSILON) * 100) / 100;
export const sum = (arr)=> arr.reduce((a,b)=>a+b,0);
export const aud = (n)=> `A$${Number(n).toFixed(2)}`;

// Simple settle algorithm (pay debts from negatives to positives)
export function settle(players){
  const debtors = players.filter(p=>p.net<0).map(p=>({name:p.name, amt: -round2(p.net)}));
  const creditors = players.filter(p=>p.net>0).map(p=>({name:p.name, amt: round2(p.net)}));
  const txns = [];
  let i=0,j=0;
  while(i<debtors.length && j<creditors.length){
    const give = Math.min(debtors[i].amt, creditors[j].amt);
    txns.push({ from: debtors[i].name, to: creditors[j].name, amount: round2(give) });
    debtors[i].amt = round2(debtors[i].amt - give);
    creditors[j].amt = round2(creditors[j].amt - give);
    if(debtors[i].amt<=0.001) i++;
    if(creditors[j].amt<=0.001) j++;
  }
  return txns;
}

export function nextFridayISO(fromISO){
  const now = fromISO ? new Date(fromISO) : new Date();
  const d = new Date(now);
  // Next Friday at 17:00 local
  const day = d.getDay(); // 0 Sun ... 5 Fri ... 6 Sat
  const diff = (5 - day + 7) % 7 || 7; // at least next Friday
  d.setDate(d.getDate() + diff);
  d.setHours(17,0,0,0);
  return d.toISOString();
}

export function toCSV(rows){
  return rows.map(r => r.map(x => {
    if (x===null || x===undefined) return '';
    const s = String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\n');
}
