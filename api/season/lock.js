// src/lib/lock.js
export const WHOAMI_KEY = "pp_whoami";

export function getWhoAmI(){
  try{ return localStorage.getItem(WHOAMI_KEY) || ""; }catch{ return ""; }
}
export function setWhoAmI(name){
  try{
    if(name) localStorage.setItem(WHOAMI_KEY, String(name));
    else localStorage.removeItem(WHOAMI_KEY);
  }catch{}
}

/**
 * Show a lightweight modal to choose a locker from current players.
 * Returns Promise<string|null>
 */
export function chooseLocker(names){
  if(!Array.isArray(names) || names.length===0){
    const v = prompt("No named players yet. Enter a name to lock as:");
    return Promise.resolve(v && v.trim() ? v.trim() : null);
  }
  return new Promise((resolve)=>{
    const root = document.createElement("div");
    root.className = "pp-choose-locker-root";
    root.innerHTML = `
      <div class="ppcl-backdrop"></div>
      <div class="ppcl-card">
        <div class="ppcl-title">Activate Host Lock</div>
        <div class="ppcl-list">
          ${names.map(n=>`<button class="ppcl-opt" data-name="${n}">${n}</button>`).join("")}
        </div>
        <div class="ppcl-actions">
          <button class="ppcl-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const cleanup = (val=null)=>{
      root.remove();
      resolve(val);
    };
    root.querySelector(".ppcl-backdrop").addEventListener("click", ()=>cleanup(null));
    root.querySelector(".ppcl-cancel").addEventListener("click", ()=>cleanup(null));
    root.querySelectorAll(".ppcl-opt").forEach(btn=>{
      btn.addEventListener("click", ()=> cleanup(btn.dataset.name));
    });
  });
}

// Inline styles
(function injectStyles(){
  const css = `
  .pp-choose-locker-root{position:fixed;inset:0;z-index:5000;display:flex;align-items:center;justify-content:center}
  .ppcl-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45)}
  .ppcl-card{position:relative;background:var(--surface,#1f2937);color:inherit;border-radius:14px;padding:14px;width:min(92vw,420px);box-shadow:0 10px 30px rgba(0,0,0,.3)}
  .ppcl-title{font-weight:700;margin-bottom:8px}
  .ppcl-list{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;max-height:240px;overflow:auto}
  .ppcl-opt{padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);cursor:pointer}
  .ppcl-opt:hover{filter:brightness(1.1)}
  .ppcl-actions{display:flex;justify-content:flex-end;margin-top:10px}
  .ppcl-cancel{padding:8px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:transparent;color:inherit;cursor:pointer}
  `;
  try{
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }catch{}
})();
