import React from "react";

export default function PlayerRow({ p, onChange, buyInAmount }){
  const update = (patch) => onChange({ ...p, ...patch });
  const remove = () => onChange({ ...p, _remove: true });

  return (
    <>
      {/* Desktop / tablet row (visible ≥ 681px) */}
      <tr className="desktop-row">
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

      {/* Mobile card row (visible ≤ 680px) */}
      <tr className="mobile-row">
        <td colSpan="5">
          <div className="player-card">
            <div className="pc-top">
              <input
                className="name pc-name"
                value={p.name}
                onChange={e=>update({name:e.target.value})}
                placeholder="Name"
                type="text"
              />
              <button className="btn danger pc-remove" onClick={remove}>Remove</button>
            </div>

            <div className="pc-row">
              <div className="pc-label">Buy-ins</div>
              <div className="pc-controls">
                <button className="btn secondary" onClick={()=>update({buyIns:Math.max(0,p.buyIns-1)})}>–</button>
                <input className="small mono pc-number" type="number" min="0" step="1"
                  value={p.buyIns}
                  onChange={e=>update({buyIns:Math.max(0,parseInt(e.target.value||0))})}
                />
                <button className="btn secondary" onClick={()=>update({buyIns:p.buyIns+1})}>+</button>
              </div>
              <div className="pc-meta">{p.buyIns} × {buyInAmount} = A${(p.buyIns*buyInAmount).toFixed(2)}</div>
            </div>

            <div className="pc-row">
              <div className="pc-label">Cash-out</div>
              <input
                className="small mono pc-number"
                type="number" min="0" step="0.01"
                value={p.cashOut}
                onChange={e=>update({cashOut:parseFloat(e.target.value||0)})}
              />
            </div>

            <div className="pc-bottom">
              <div className={"pc-net " + ((p.cashOut - p.buyIns*buyInAmount) >= 0 ? "pos" : "neg")}>
                Net: {(p.cashOut - p.buyIns*buyInAmount).toFixed(2)}
              </div>
              <div className="pc-actions">
                <button className="btn secondary" onClick={()=>update({buyIns:Math.max(0,p.buyIns-1)})}>−1 buy-in</button>
                <button className="btn success" onClick={()=>update({buyIns:p.buyIns+1})}>+1 buy-in</button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}
