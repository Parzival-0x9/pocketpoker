export const aud = (n)=> new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).format(Number(n||0));
export const sum = (a)=> a.reduce((x,y)=>x+Number(y||0),0);
export const round2 = (n)=> Math.round((Number(n||0)+Number.EPSILON)*100)/100;
export function settle(players){
  const winners = players.map(p=>({name:p.name,net:round2(p.net)})).filter(p=>p.net>0).sort((a,b)=>b.net-a.net);
  const losers  = players.map(p=>({name:p.name,net:round2(p.net)})).filter(p=>p.net<0).sort((a,b)=>a.net-b.net);
  const txns=[]; let i=0,j=0;
  while(i<losers.length&&j<winners.length){
    const owe=round2(Math.min(winners[j].net,-losers[i].net));
    if(owe>0){ txns.push({from:losers[i].name,to:winners[j].name,amount:owe});
      winners[j].net=round2(winners[j].net-owe); losers[i].net=round2(losers[i].net+owe); }
    if(winners[j].net<=0.001) j++; if(losers[i].net>=-0.001) i++;
  }
  return txns;
}
export function nextFridayISO(iso){
  const d = iso ? new Date(iso) : new Date();
  const day = d.getDay(); // 5 = Fri
  const diff = (5 - day + 7) % 7 || 7;
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff, 17, 0, 0);
  return due.toISOString();
}
export function toCSV(rows){
  return rows.map(r=> r.map(v=>{
    if(v===null||v===undefined) return '';
    const s = String(v).replace(/"/g,'""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\n');
}