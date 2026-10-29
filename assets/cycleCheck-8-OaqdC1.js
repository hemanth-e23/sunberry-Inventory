import{as as _,y as E,at as I,x as T,a1 as w,z as H}from"./index-Ds99f64_.js";const N=e=>e.replace(/^FG[- ]?/,""),F=(e,t)=>{const o=String(t||"").trim().toUpperCase();if(!o)return null;const l=N(o);return e.find(s=>{const c=(s.name||"").toUpperCase(),m=N(c);return m===o||c===o||l&&m===l||s.id===String(t).trim()||s.barcode&&s.barcode.toUpperCase()===o})||null},U=(e,t,o,l)=>{const s=new Set;for(const c of e)for(const m of c.pallets)l.has(m.licence_number)||(t.has(c.key)||o.has(m.id))&&s.add(m.id);return[...s]},k=e=>`sb.cycleCheck.session.${e||"anon"}`,O=e=>e*60*1e3,R=(e,t,o=Date.now())=>{try{const l=window.localStorage.getItem(k(e));if(!l)return null;const s=JSON.parse(l);return!s||typeof s!="object"||!s.draft&&s.lastAt&&o-s.lastAt>O(t)?null:{rows:[],...s}}catch{return null}},M=(e,t)=>{try{t?window.localStorage.setItem(k(e),JSON.stringify(t)):window.localStorage.removeItem(k(e))}catch{}},W=e=>({row_name:e.row_name,ok:!A(e),expected:e.expected_pallets||0,not_here:e.not_here||0,found:e.found||0,moved_in:e.moved_in||0,created:e.created||0,messages:(e.scans||[]).filter(t=>t.message).map(t=>t.message)}),K=(e=[])=>({rows:e.length,ok:e.filter(t=>t.ok).length,differences:e.filter(t=>!t.ok).length,not_here:e.reduce((t,o)=>t+(o.not_here||0),0),found:e.reduce((t,o)=>t+(o.found||0),0),moved_in:e.reduce((t,o)=>t+(o.moved_in||0),0),created:e.reduce((t,o)=>t+(o.created||0),0)}),A=(e={})=>!!(e.variancesCount||e.not_here||e.moved_in||e.found||e.created),D="gun_row_check",h=e=>{if(!e)return 0;const t=String(e),o=Date.parse(/T/.test(t)&&!/(Z|[+-]\d{2}:\d{2})$/.test(t)?`${t}Z`:t);return Number.isNaN(o)?0:o},b=e=>e.summary?.kind===_.KIND,q=(e=[],t=60)=>{const o=e.filter(n=>n.summary?.kind===D&&n.summary.source!==_.SOURCE_SHEET).sort((n,a)=>String(n.performedById).localeCompare(String(a.performedById))||h(n.createdAt)-h(a.createdAt)||String(n.id).localeCompare(String(a.id))),l=new Map,s=new Map;for(const n of o){const a=String(n.performedById),p=n.summary.session_id;let i;if(p)i=`${a}|${p}`;else{const d=h(n.createdAt),r=s.get(a);i=r&&r.day===n.countDate&&d&&r.last&&d-r.last<=O(t)?r.key:`${a}|auto-${n.id}`,s.set(a,{key:i,last:d,day:n.countDate})}l.has(i)||l.set(i,[]),l.get(i).push(n)}const c=[...l.entries()].map(([n,a])=>{const p=a.map(d=>({id:d.id,rowName:d.summary.row_name||"—",checkedAt:d.createdAt,ok:!A(d.summary),expected:d.summary.expected_pallets||0,notHere:d.summary.not_here||0,found:d.summary.found||0,movedIn:d.summary.moved_in||0,created:d.summary.created||0,items:Array.isArray(d.items)?d.items:[]})),i=d=>p.reduce((r,u)=>r+u[d],0);return{type:"session",key:n,sessionId:a[0].summary.session_id||null,inferred:!a[0].summary.session_id,performedBy:a[0].performedBy,performedById:a[0].performedById,countDate:a[0].countDate,startedAt:a[0].createdAt,endedAt:a[a.length-1].createdAt,sortAt:h(a[a.length-1].createdAt),rows:p,rowsChecked:p.length,rowsOk:p.filter(d=>d.ok).length,rowsWithDifferences:p.filter(d=>!d.ok).length,notHere:i("notHere"),found:i("found"),movedIn:i("movedIn"),created:i("created")}}),m=e.filter(n=>n.summary?.kind!==D).filter(n=>!b(n)||n.summary.status===_.STATUS_SUBMITTED).map(n=>{const a=b(n)&&n.summary.submitted_at||n.createdAt||null,p=L(n.items);return{type:"count",key:n.id,count:n,sheetNo:b(n)&&n.summary.sheet_no||null,at:a,sortAt:h(a)||h(n.countDate),...p,skipped:Math.max(p.skipped,(n.summary?.skipped||[]).length),warnings:(n.summary?.warnings||[]).length}});return[...c,...m].sort((n,a)=>a.sortAt-n.sortAt)},L=(e=[])=>{const t=Array.isArray(e)?e:[],o=t.flatMap(s=>s.arrived||[]),l=s=>o.filter(c=>c.result===s).length;return{total:t.length,ok:t.filter(s=>s.status==="ok").length,differences:t.filter(s=>s.status==="shortage"||s.status==="overage").length,skipped:t.filter(s=>s.status==="skipped").length,recorded:t.filter(s=>s.status==="recorded").length,notHere:t.reduce((s,c)=>s+(c.notHere?.length||0),0),found:l("found"),movedIn:l("moved"),created:l("created")}},y=(e,t)=>String(e??"").localeCompare(String(t??""),void 0,{numeric:!0,sensitivity:"base"}),G=(e=[])=>[...e].sort((t,o)=>y(t.location,o.location)||y(t.productName,o.productName)||y(t.lotNo,o.lotNo)),z=e=>[...new Set(String(e||"").split(/[\s,;]+/).map(t=>t.trim().toUpperCase()).filter(Boolean))],$=()=>({rowCounted:{},notHere:[],extras:{},counts:{},legacy:{}}),S=e=>`sb.countSheet.draft.${e}`,Y=e=>{try{const t=window.localStorage.getItem(S(e)),o=t?JSON.parse(t):null;return o&&typeof o=="object"?{...$(),...o}:$()}catch{return $()}},J=(e,t)=>{try{t?window.localStorage.setItem(S(e),JSON.stringify(t)):window.localStorage.removeItem(S(e))}catch{}},v=e=>{if(e==null||String(e).trim()==="")return null;const t=Number(e);return Number.isInteger(t)&&t>=0?t:null},x=e=>e?.summary?.sheet_type===_.TYPE_FG,j=(e=[])=>[...e].sort((t,o)=>y(t.area_label||t.area_name,o.area_label||o.area_name)||y(t.row_name,o.row_name)),C=e=>{const t=e?.summary?.sheet||{rows:[],legacy:[]};return{...t,rows:j(t.rows||[])}},Z=(e,t)=>{const o=C(e),l=x(e),s=new Set(t.notHere||[]),c=(o.rows||[]).filter(n=>t.rowCounted?.[n.row_id]).map(n=>{if(l)return{row_id:n.row_id,counted:!0,not_here_pallet_ids:n.lines.flatMap(a=>a.pallets).filter(a=>s.has(a.id)).map(a=>a.id),extra_licences:z(t.extras?.[n.row_id])};if(n.empty){const a=String(t.extras?.[n.row_id]||"").trim();return{row_id:n.row_id,counted:!0,lines:[],...a?{found_note:a}:{}}}return{row_id:n.row_id,counted:!0,lines:n.lines.map(a=>({placement_id:a.placement_id,counted_units:v(t.counts?.[a.placement_id])})).filter(a=>a.counted_units!==null)}}),m=(o.legacy||[]).map(n=>({receipt_id:n.receipt_id,counted:v(t.legacy?.[n.receipt_id])})).filter(n=>n.counted!==null);return{rows:c,legacy:m}},V=(e,t)=>{const l=C(e).rows||[],s=l.filter(n=>t.rowCounted?.[n.row_id]);let c=0,m=0;if(!x(e))for(const n of s)for(const a of n.lines){const p=t.counts?.[a.placement_id];p==null||String(p).trim()===""?c+=1:v(p)===null&&(m+=1)}return{rowsTotal:l.length,rowsCounted:s.length,emptyConfirmed:s.filter(n=>n.empty&&!String(t.extras?.[n.row_id]||"").trim()).length,emptyWithFinds:s.filter(n=>n.empty&&String(t.extras?.[n.row_id]||"").trim()).length,blankLines:c,badLines:m}},Q=(e,t)=>{if(!e||e.status==="other_warehouse")return"unchanged";if(!e.exists){const o=e.explanation?.kind;return o==="not_a_sticker"||o==="unknown_product"||o==="number_taken"?"invalid":"created"}return e.status===w.IN_STOCK?e.storage_row_id===t?"here":"moved":[w.MISSING,w.NOT_PRODUCED,w.CANCELLED].includes(e.status)?"found":"unchanged"},f=(e,t,o=`${t}s`)=>`${e} ${e===1?t:o}`,X=({stats:e,payload:t,extras:o,fg:l})=>{const s=[`${e.rowsCounted} of ${e.rowsTotal} rows marked counted. Rows not marked are left as they are.`];e.emptyConfirmed&&s.push(`${f(e.emptyConfirmed,"empty row")} confirmed empty.`),e.emptyWithFinds&&s.push(l?`${f(e.emptyWithFinds,"row")} the system had as empty had pallets found in it.`:`${f(e.emptyWithFinds,"row")} the system had as empty had something found — recorded as a note only, stock is not changed.`);const c=t.rows.reduce((m,n)=>m+(n.not_here_pallet_ids?.length||0),0);if(c&&s.push(`${f(c,"pallet")} ticked ✗ will be marked MISSING.`),l){const m=t.rows.reduce((n,a)=>n+(a.extra_licences?.length||0),0);if(m&&!o)s.push(`${f(m,"extra licence")} will each be moved here, found or created from its sticker — that one pallet only.`);else if(m){const n=u=>o.filter(g=>g.outcome===u),a=u=>u.map(g=>`${g.licence} (${g.row_name})`).join(", "),p=n("moved"),i=n("found"),d=n("created"),r=n("unchanged");p.length&&s.push(`Moved here from another row: ${a(p)}.`),i.length&&s.push(`Found — back in stock here: ${a(i)}.`),d.length&&s.push(`Created from the sticker (never in the system): ${a(d)}. Only that pallet is created, not a range.`),r.length&&s.push(`Not changed: ${r.map(u=>`${u.licence} — ${u.message||"cannot be put here"}`).join("; ")}.`)}}return e.blankLines&&s.push(`${f(e.blankLines,"line")} in counted rows are blank and will be skipped.`),s.push("There is no approval step — changes apply immediately."),s},B=e=>e.sequence!=null?String(e.sequence).padStart(3,"0"):e.licence_number,ee=e=>{const t=H,o=e.summary||{},l=C(e),s=x(e),c='<span class="box"></span>',m=(l.rows||[]).map(i=>{let d;return i.empty?d=`<div class="empty-row">Empty — system shows nothing here.
        <span class="empty-tick">${c} Confirmed empty</span></div>
        <div class="extra">Found here (${s?"licence #":"product · lot · count"}): <span class="line"></span></div>`:s?d=`<table><thead><tr><th style="width:22%">Product</th><th style="width:13%">Lot</th>
        <th class="num" style="width:7%">System</th><th>Pallets — ✓ seen · ✗ not here</th>
        <th style="width:11%">Pallets counted</th></tr></thead><tbody>${i.lines.map(r=>`<tr>
        <td><b>${t(r.product_name)}</b></td><td class="mono">${t(r.lot_number||"—")}</td>
        <td class="num">${r.count}</td>
        <td>${r.pallets.map(u=>`<span class="lic${u.is_held?" held":""}">${c}${t(B(u))}${u.is_held?' <b class="held-tag">ON HOLD</b>':""}</span>`).join("")}</td>
        <td><span class="count-box"></span></td></tr>`).join("")}</tbody></table>
        <div class="extra">Extra found (licence #): <span class="line"></span></div>`:d=`<table><thead><tr><th style="width:24%">Product</th><th style="width:14%">Vendor lot</th>
        <th style="width:9%">BBD</th><th class="num" style="width:10%">System sealed</th>
        <th style="width:14%">Open / held</th><th style="width:13%">Counted sealed</th><th>Notes</th></tr></thead>
        <tbody>${i.lines.map(r=>`<tr>
        <td><b>${t(r.product_name)}</b></td><td class="mono">${t(r.vendor_lot_number||r.lot_code||"—")}</td>
        <td>${r.bbd?t(E(r.bbd)):"—"}</td>
        <td class="num"><b>${r.full_units}</b> ${t(r.unit_label)}</td>
        <td>${r.open_units?`${r.open_units} open`:""}${r.open_units&&(r.held_units||r.lot_is_held)?" · ":""}${r.held_units?`<b class="held-tag">${r.held_units} ON HOLD</b>`:""}${r.lot_is_held?`${r.held_units?" ":""}<b class="held-tag">LOT ON HOLD</b>`:""}${!r.open_units&&!r.held_units&&!r.lot_is_held?"—":""}</td>
        <td><span class="count-box"></span></td><td></td></tr>`).join("")}</tbody></table>
        <div class="extra">Extra found (product · lot · count): <span class="line"></span></div>`,`<section class="row">
      <div class="row-bar"><div><span class="row-name">${t(i.row_name)}</span><span class="row-area">${t(i.area_name)}</span></div>
      <div class="row-done">${c} Row counted <span class="sheet-tag">${t(o.sheet_no)}</span></div></div>
      ${d}</section>`}).join(""),n=l.legacy||[],a=n.length?`<section class="row">
      <div class="row-bar"><div><span class="row-name">Not on a rack</span>
      <span class="row-area">count is recorded, nothing is changed</span></div>
      <div class="row-done"><span class="sheet-tag">${t(o.sheet_no)}</span></div></div>
      <table><thead><tr><th style="width:30%">Product</th><th style="width:16%">Lot</th><th class="num" style="width:16%">System</th>
      <th style="width:14%">Counted</th><th>Notes</th></tr></thead><tbody>${n.map(i=>`<tr>
      <td><b>${t(i.product_name)}</b>${i.is_held?' <b class="held-tag">ON HOLD</b>':""}</td><td class="mono">${t(i.lot_number||"—")}</td>
      <td class="num">${Number(i.quantity||0).toLocaleString()} ${t(i.unit||"")}${i.container_count?` (${i.container_count} ${t(i.container_unit||"")})`:""}</td>
      <td><span class="count-box"></span></td><td></td></tr>`).join("")}</tbody></table></section>`:"",p=s?'Walk each row. Tick ✓ every pallet you see; cross ✗ the ones that are not there. Write any other licence you find under "Extra found". Tick "Row counted" when done. ON HOLD pallets are counted like any other. On an empty row tick "Confirmed empty" or write what you found.':'Walk each row. Write the number of SEALED units you count. Open and held units are for information; ON HOLD stock is counted like any other. Tick "Row counted" when done. On an empty row tick "Confirmed empty" or write what you found.';return`<!DOCTYPE html>
<html>
<head>
  <title>Count Sheet ${t(o.sheet_no)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 11pt; color: #000; background: #fff; padding: 8mm; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm;
      border-bottom: 2px solid #000; padding-bottom: 3mm; margin-bottom: 3mm; }
    .sheet-no { font-family: monospace; font-size: 22pt; font-weight: 700; }
    .scope { font-size: 12pt; font-weight: 700; margin-top: 1mm; }
    .meta { font-size: 9pt; margin-top: 1mm; }
    .sign { font-size: 12pt; white-space: nowrap; }
    .sign .line { display: inline-block; border-bottom: 1px solid #000; width: 55mm; margin: 0 5mm 0 2mm; }
    .how { font-size: 9.5pt; margin-bottom: 4mm; }
    .row { border: 1.5px solid #000; margin-bottom: 4mm; break-inside: avoid; page-break-inside: avoid; }
    .row-bar { display: flex; justify-content: space-between; align-items: center; padding: 2mm 3mm;
      background: #e6e6e6; border-bottom: 1.5px solid #000;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .row-name { font-size: 15pt; font-weight: 700; }
    .row-area { font-size: 10pt; margin-left: 4mm; }
    .row-done { font-size: 11pt; font-weight: 700; white-space: nowrap; }
    .sheet-tag { font-family: monospace; font-weight: 400; font-size: 9pt; margin-left: 4mm; }
    table { width: 100%; border-collapse: collapse; }
    th { font-size: 8.5pt; text-transform: uppercase; text-align: left; padding: 1.5mm 2mm; border-bottom: 1px solid #000; }
    td { padding: 2mm; border-top: 1px solid #aaa; vertical-align: top; }
    .num { text-align: right; }
    .mono { font-family: monospace; font-size: 11pt; }
    .lic { display: inline-block; min-width: 16mm; margin: 0.6mm 3mm 0.6mm 0; font-family: monospace; font-size: 12pt; white-space: nowrap; }
    .box { display: inline-block; width: 4.5mm; height: 4.5mm; border: 1.3px solid #000; margin-right: 1.2mm; vertical-align: -0.8mm; }
    .count-box { display: inline-block; width: 24mm; height: 9mm; border: 1.5px solid #000; }
    .extra { padding: 2.5mm 3mm; border-top: 1px solid #aaa; font-size: 10pt; display: flex; gap: 2mm; }
    .extra .line { flex: 1; border-bottom: 1px solid #000; }
    .held-tag { border: 1.5px solid #000; padding: 0 1mm; font-size: 9pt; letter-spacing: 0.03em; }
    .lic.held { border: 1.5px dashed #000; padding: 0 1mm; }
    .empty-row { padding: 2.5mm 3mm; font-style: italic; display: flex; justify-content: space-between; gap: 6mm; }
    .empty-tick { font-style: normal; font-weight: 700; white-space: nowrap; }
    @media print { body { padding: 0; } @page { size: A4 landscape; margin: 8mm; } }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <div class="sheet-no">${t(o.sheet_no)}</div>
      <div class="scope">${t(o.scope||I[o.sheet_type]||"")}</div>
      <div class="meta">Printed from system ${t(T(o.generated_at))}${o.generated_by?` by ${t(o.generated_by)}`:""}
        · ${(l.rows||[]).length} rows</div>
    </div>
    <div class="sign">Counted by<span class="line"></span>Date<span class="line" style="width:35mm"></span></div>
  </div>
  <div class="how">${p}</div>
  ${m||"<p>Nothing on a rack for this selection.</p>"}
  ${a}
</body>
</html>`};export{j as a,V as b,Z as c,v as d,ee as e,Q as f,X as g,q as h,G as i,R as j,M as k,Y as l,K as m,U as n,F as o,z as p,W as q,J as s};
