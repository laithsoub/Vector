// Pull candidate Eaton EL material lines (catalogue-looking tokens / qty lines)
// out of an email body — shared by the Inbox EL Pricer and the Quick Quote panel.
export function extractMaterialHints(body: string): string {
  const hits: string[] = [];
  const catalogRe = /\b(MP2[A-Z0-9\-]*|NXL[A-Z0-9\-]*|LUM[A-Z0-9\-]*|AT-S[A-Z0-9\-]*|LP-STAR[A-Z0-9\-]*|I-P65[A-Z0-9 \-]*|IP65[A-Z0-9\-]*|CGS[A-Z0-9\-]*|CG-S[A-Z0-9\-]*|CGLine[A-Z0-9\-]*|CrystalWay[A-Z0-9\-]*|RoundTech[A-Z0-9\-]*|NexiLite[A-Z0-9\-]*|ExLin[A-Z0-9\-]*|LHID[A-Z0-9\-]*|EMP[A-Z0-9\-]*|CEAG[A-Z0-9\-]*)\b/i;
  const qtyLineRe = /\d+\s*[xX×]\s*[A-Z][A-Z0-9\-]{3,}|[A-Z][A-Z0-9\-]{3,}\s*[,;]\s*\d+/;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.length > 200) continue;
    if (catalogRe.test(t) || qtyLineRe.test(t)) hits.push(t);
  }
  return hits.join('\n');
}
