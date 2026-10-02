const i=/^\s*\[(Sent Back|Rejected) by ([^\]]*)\]:\s*(.*)$/,o=e=>{const t=[],s=[];return String(e||"").split(`
`).forEach(c=>{const n=c.match(i);if(n)s.push({action:n[1]==="Sent Back"?"sent_back":"rejected",by:n[2].trim(),text:n[3].trim()});else if(s.length){const a=s[s.length-1];a.text=a.text?`${a.text}
${c}`.trim():c.trim()}else t.push(c)}),{text:t.join(`
`).trim(),reviews:s}},r=e=>o(e).reviews.some(t=>t.action==="sent_back"),l=e=>{const t=o(e).reviews.filter(s=>s.action==="sent_back");return t.length?t[t.length-1]:null},m=e=>o(e).text,h=(e,t)=>{const{reviews:s}=o(t),c=s.map(n=>`[${n.action==="sent_back"?"Sent Back":"Rejected"} by ${n.by}]: ${n.text}`);return[String(e||"").trim(),...c].filter(Boolean).join(`
`)};export{h as c,r as h,l,m as s};
