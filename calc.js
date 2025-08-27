
export const aud = (n)=>`A$${Number(n).toFixed(2)}`;
export const sum = (arr)=>arr.reduce((a,b)=>a+Number(b||0),0);
export const round2 = (n)=>Math.round(Number(n)*100)/100;

// simple settle stub (replace with real algorithm if you had one before)
export function settle(players){ return []; }

export function nextFridayISO(fromISO){
  const d = fromISO ? new Date(fromISO) : new Date();
  const day = d.getDay();
  const diff = (5 - day + 7) % 7 || 7;
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate()+diff, 17, 0, 0);
  return due.toISOString();
}

export const toCSV = (rows)=> rows.map(r=> r.map(x=> `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
