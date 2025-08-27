
import React from "react";

// Desktop table row only; mobile uses card layout defined in App.jsx
export default function PlayerRow({ p, onChange, buyInAmount }){
  const update = (patch) => onChange({ ...p, ...patch });
  const remove = () => onChange({ ...p, _remove: true });
  return (
    <tr>
      <td><input className="name" value={p.name} onChange={e=>update({name:e.target.value})} placeholder="Name" type="text" /></td>
      <td className="center">
        <div className="toolbar">
          <button className="btn secondary" onClick={()=>update({buyIns:Math.max(0,p.buyIns-1)})}>–</button>
          <input className="small mono" type="number" min="0" step="1" value={p.buyIns} onChange={e=>update({buyIns:Math.max(0,parseInt(e.target.value||0))})} />
          <button className="btn secondary" onClick={()=>update({buyIns:p.buyIns+1})}>+</button>
        </div>
        <div className="meta">{p.buyIns} × {buyInAmount} = <span className="mono">A${(p.buyIns*buyInAmount).toFixed(2)}</span></div>
      </td>
      <td className="center">
        <input className="small mono" type="number" min="0" step="0.01" value={p.cashOut} onChange={e=>update({cashOut:parseFloat(e.target.value||0)})} />
        <div className="meta">cash-out</div>
      </td>
      <td className="center mono">{(p.cashOut - p.buyIns*buyInAmount).toFixed(2)}</td>
      <td className="center"><button className="btn danger" onClick={remove}>Remove</button></td>
    </tr>
  );
}
