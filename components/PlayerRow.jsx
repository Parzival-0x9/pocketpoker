
import React, { useState, useEffect, memo } from "react";

function PlayerRow({ p, onChange, buyInAmount }){
  const [name, setName] = useState(p.name || "");
  const [buyIns, setBuyIns] = useState(p.buyIns || 0);
  // Keep cashOut as a string buffer so typing isn't disrupted, commit onBlur/Enter
  const [cashOutStr, setCashOutStr] = useState(
    (p.cashOut===0 || p.cashOut) ? String(p.cashOut) : ""
  );

  useEffect(()=>{ setName(p.name || ""); }, [p.id, p.name]);
  useEffect(()=>{ setBuyIns(p.buyIns || 0); }, [p.id, p.buyIns]);
  useEffect(()=>{
    setCashOutStr((p.cashOut===0 || p.cashOut) ? String(p.cashOut) : "");
  }, [p.id, p.cashOut]);

  const commit = (patch) => onChange({ ...p, ...patch });
  const remove = () => onChange({ ...p, _remove: true });

  const commitCashOut = () => {
    const v = cashOutStr.trim();
    const n = v==="" ? 0 : parseFloat(v);
    const safe = isNaN(n) ? 0 : n;
    if (safe !== p.cashOut) commit({ cashOut: safe });
    // normalize display
    setCashOutStr(String(safe));
  };

  return (
    <tr>
      <td>
        <input
          className="name"
          value={name}
          onChange={e=>setName(e.target.value)}
          onBlur={()=> name!==p.name && commit({ name })}
          placeholder="Name"
          type="text"
        />
      </td>
      <td className="center">
        <div className="toolbar">
          <button className="btn secondary" onClick={()=>{ const v=Math.max(0,(buyIns-1)); setBuyIns(v); commit({buyIns:v}); }}>–</button>
          <input
            className="small mono"
            type="number" min="0" step="1"
            value={buyIns}
            onChange={e=>{
              const v=e.target.value===""?0:parseInt(e.target.value,10);
              const n = isNaN(v)?0:Math.max(0,v);
              setBuyIns(n);
              commit({buyIns:n});
            }}
          />
          <button className="btn secondary" onClick={()=>{ const v=buyIns+1; setBuyIns(v); commit({buyIns:v}); }}>+</button>
        </div>
        <div className="meta">{buyIns} × {buyInAmount} = <span className="mono">A${(buyIns*buyInAmount).toFixed(2)}</span></div>
      </td>
      <td className="center">
        <input
          className="small mono"
          type="text" inputMode="decimal"
          value={cashOutStr}
          onChange={e=>setCashOutStr(e.target.value)}
          onBlur={commitCashOut}
          onKeyDown={e=>{ if(e.key==='Enter'){ e.currentTarget.blur(); } }}
          placeholder="0.00"
        />
        <div className="meta">cash-out</div>
      </td>
      <td className="center mono">{( (p.cashOut||0) - buyIns*buyInAmount ).toFixed(2)}</td>
      <td className="center"><button className="btn danger" onClick={remove}>Remove</button></td>
    </tr>
  );
}

export default memo(PlayerRow);
