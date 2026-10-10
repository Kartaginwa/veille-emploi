// Veille emploi: lit toutes les sources de sources.txt, compare avec la veille précédente
// et écrit data/nouveautes.json, data/sante.json, data/state.json. Aucun appel à un LLM.
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const TODAY = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const POS = /co[uû]ts? de revient|prix de revient|costing|conseill|agent[e]?\b|charg[ée]e? (de|d')|coordonn|commissaire|directeur|directrice|gestionnaire|analyste|responsable|adjoint|chef\b|repr[ée]sentant|strat[ée]g|[ée]conomie circulaire|circular economy|mati[èe]res r[ée]siduelles|symbiose industrielle|d[ée]veloppement (des affaires|[ée]conomique)|business development|advisor|officer|manager|coordinator|analyst|director|specialist/i;
const GENERIC = /favoris|favourites|skip to|sign up|report a problem|salaires|publier une offre|ajouter|current location|selected date|filters|cookie|se connecter|^emplois |various locations|remove keyword|create alert|labour market|training and careers|rss job feed|help -|support|terms of use|plus account|^new$/i;
const POSTURL = /jobposting\/|offre-d-emploi|\/job\/|viewjob|\/view\?|\/rc\/clk|\/clk\?|\/jobs?\/[^/]+/i;
const NEG = /stagiaire|[ée]tudiant|student|intern\b|internship|technicien|pr[ée]pos[ée]|journalier|caissier|conducteur|op[ée]rateur|infirm|m[ée]decin|ing[ée]nieur|[ée]lectric|m[ée]canic|menuis|soudeur|cuisini|serveu|chauffeur|commis\b|ressources humaines|\bRH\b|paie\b|sauveteur|moniteur|animateur|brigadier|pompier|policier|concierge|g[ée]om[èe]tre|arpenteur|comptable|avocat|MRC des Laurentides|Corporation de d[ée]veloppement [ée]conomique/i;
const HARD = /stagiaire|[ée]tudiant|student|intern\b|internship|MRC des Laurentides|Corporation de d[ée]veloppement [ée]conomique/i;
const PRO = /urbanist|greffier|greffi[èe]re|tr[ée]sori|planificat|inspecteur|inspectrice|contr[ôo]leur|agronome|biologiste|architecte|paysagiste|biblioth[ée]caire|archiviste|technicien|technicienne|ing[ée]nieur|avocat|notaire|comptable|conseill|gestion|agent|charg|coordonn|responsable|directeur|directrice|analyste|sp[ée]cialiste|p[ée]dagog|travailleur social|intervenant|organisateur|animateur communautaire|dentiste|[ée]valuateur/i;
const ecartes = new Map();
function ecarte(src, it, raison) { const k = src.name + '|' + it.href + '|' + it.text.slice(0, 80); if (!ecartes.has(k)) ecartes.set(k, { source: src.name, titre: it.text, url: it.href, raison, vuLe: TODAY }); }
// Décide si un lien est retenu. Dans les Laurentides: on ne jette rien de ce qui ressemble à un poste (sauf exclusions dures).
function triage(src, l) {
  const t = l.text, ctx = LAUR.test(src.name + ' ' + src.url + ' ' + t);
  if (HARD.test(t)) { ecarte(src, l, 'exclusion (stage/étudiant/ancien employeur)'); return false; }
  const pos = POS.test(t) || POSTURL.test(l.href);
  if (ctx) { if (pos || PRO.test(t)) return true; if (NEG.test(t)) { ecarte(src, l, 'titre métier/technique (Laurentides)'); return false; } ecarte(src, l, 'titre sans mot-clé reconnu (Laurentides)'); return false; }
  if (NEG.test(t)) { ecarte(src, l, 'titre métier/technique'); return false; }
  if (pos) return true;
  if (PRO.test(t) && /emploi|carri|job|poste/i.test(l.href)) return true;
  return false;
}
const JOBURL = /emploi|offre|job|poste|career|carri[èe]re|posting|requisition|recrut|affichage|vacan/i;
const NAV = /^(accueil|contact|nous joindre|à propos|a propos|politique|confidentialit|plan du site|infolettre|facebook|linkedin|instagram|youtube|twitter|menu|recherche|voir (plus|tout)|en savoir plus|lire la suite|suivant|précédent|retour)/i;

const CFG = fs.readFileSync('sources.txt', 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => { const [type, name, url] = l.split('|').map(s => s.trim()); return { type, name, url }; });

fs.mkdirSync('data', { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson('data/state.json', {});
const sante = {};
const nouveaux = [];
const disparus = [];

const abs = (h, base) => { try { return new URL(h, base).href.split('#')[0]; } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { html: await r.text(), final: r.url };
  } finally { clearTimeout(t); }
}
function linksFromHtml(html, base) {
  const $ = cheerio.load(html); const out = [];
  $('a[href]').each((_, a) => { const text = $(a).text().replace(/\s+/g, ' ').trim(); const href = abs($(a).attr('href'), base); if (href && /^https?:/.test(href)) out.push({ text, href }); });
  return out;
}

let browser;
async function getBrowser() { if (!browser) browser = await chromium.launch({ args: ['--no-sandbox'] }); return browser; }
async function browserLinks(url, { scroll = true, extra } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({ userAgent: UA, locale: 'fr-CA' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (scroll) { for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 3000); await sleep(400); } }
    if (extra) await extra(page);
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.href })));
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr, li, article, [role=listitem]')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t.length > 15 && t.length < 300).slice(0, 400));
    return { links: links.filter(l => /^https?:/.test(l.href)), rows, final: page.url() };
  } finally { await ctx.close(); }
}

// Chaîne de méthodes: fetch simple, puis navigateur. Retourne {links, method}
async function getLinks(url) {
  const errs = [];
  try { const { html, final } = await fetchHtml(url); const links = linksFromHtml(html, final); if (links.length >= 5) return { links, method: 'fetch' }; errs.push('fetch: peu de liens (' + links.length + ')'); } catch (e) { errs.push('fetch: ' + e.message); }
  try { const r = await browserLinks(url); if (r.links.length) return { links: r.links, rows: r.rows, method: 'navigateur' }; errs.push('navigateur: aucun lien'); } catch (e) { errs.push('navigateur: ' + e.message.split('\n')[0]); }
  const err = new Error(errs.join(' | ')); throw err;
}

function relevant(l, keepAll) {
  const t = l.text; if (!t || t.length < 8 || t.length > 220 || NAV.test(t)) return false;
  if (NEG.test(t)) return false;
  return POS.test(t) || (keepAll && JOBURL.test(l.href));
}

const STRONG = /commissaire|conseill|charg[ée]e? (de|d')|agent[e]?\b|coordonn|analyste|gestionnaire|adjoint|chef\b|directeur|directrice|advisor|officer|manager|coordinator/i;
const DOMAIN = /co[uû]ts? de revient|prix de revient|costing|cost analyst|comptabilit[ée] de gestion|contr[ôo]le de gestion|d[ée]veloppement [ée]conomique|agroalimentaire|bioalimentaire|partenariat|d[ée]veloppement des affaires|business development|projet|communication|environnement|culture|[ée]conomie sociale|relations gouvernementales|[ée]conomie circulaire|circular economy|mati[èe]res r[ée]siduelles|symbiose industrielle|d[ée]veloppement durable|entrepreneuriat|investissement/i;
const PLACE = /laurentides|saint-j[ée]r[ôo]me|mont-tremblant|blainville|sainte-th[ée]r[èe]se|saint-eustache|lachute|sainte-ad[èe]le|saint-sauveur|pr[ée]vost|mirabel|montr[ée]al|t[ée]l[ée]travail|remote|hybride/i;
const SENIOR = /vice-pr[ée]sident|directeur g[ée]n[ée]ral|directrice g[ée]n[ée]rale|pr[ée]sident|chief|senior|stagiaire|junior|adjoint[e]? administratif/i;
const LAUR = /laurentides|saint-j[ée]r[ôo]me|mont-tremblant|blainville|boisbriand|rosem[èe]re|sainte-th[ée]r[èe]se|saint-eustache|lachute|sainte-ad[èe]le|saint-sauveur|pr[ée]vost|mirabel|val-david|sainte-agathe|saint-colomban|bois-des-filion|deux-montagnes|labelle|morin-heights|piedmont|saint-donat|brownsburg|argenteuil|rivi[èe]re-du-nord/i;
const ANCONS = /analyste|analyst\b|conseill(er|[èe]re)\b|advisor/i;
function rough(text, href, src = '') { let s = 0; if (ANCONS.test(text) && LAUR.test(text + ' ' + href + ' ' + src)) s += 4; if (STRONG.test(text)) s += 3; if (DOMAIN.test(text)) s += 2; if (PLACE.test(text + ' ' + href)) s += 2; if (SENIOR.test(text)) s -= 2; return s; }

const seenUrls = new Set();
function record(src, items, ok) {
  const st = (state[src.name] ||= {});
  const seen = new Set();
  let added = 0;
  for (const it of items) {
    const key = it.href.replace(/[?&](utm_[^&]+|session[^&]*)/g, '') + '|' + it.text.slice(0, 80);
    seen.add(key);
    if (!st[key]) { const nu = it.href.split('#')[0]; if (seenUrls.has(nu) && !/IrcVisitor|offres-demploi-2944/.test(nu)) { st[key] = { t: it.text, u: it.href, d: TODAY, m: 0 }; continue; } seenUrls.add(nu); st[key] = { t: it.text, u: it.href, d: TODAY, m: 0 }; nouveaux.push({ source: src.name, titre: it.text, url: it.href, vuLe: TODAY, pre: rough(it.text, it.href), _st: st[key] }); added++; }
    else st[key].m = 0;
  }
  if (ok && items.length) for (const k of Object.keys(st)) { if (!seen.has(k)) { st[k].m++; if (st[k].m >= 2) { disparus.push({ source: src.name, titre: st[k].t, url: st[k].u }); delete st[k]; } } }
  return added;
}

async function runSource(src) {
  const rec = { type: src.type, url: src.url };
  try {
    let items = [];
    if (src.type === 'W') {
      const [tenant, wd, site] = src.url.split(';');
      let offset = 0, total = 1;
      while (offset < total && offset < 400) {
        const r = await fetch(`https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }) });
        if (!r.ok) throw new Error('Workday HTTP ' + r.status);
        const j = await r.json(); total = j.total || 0;
        for (const p of j.jobPostings || []) items.push({ text: `${p.title} (${p.locationsText || ''})`, href: `https://${tenant}.${wd}.myworkdayjobs.com/${site}${p.externalPath}` });
        if (!(j.jobPostings || []).length) break; offset += 20;
      }
      rec.method = 'api Workday'; rec.liensLus = items.length;
      items = items.filter(l => triage(src, l));
    } else if (src.type === 'O') {
      const r = await oracleMtl(src.url); items = r.items; rec.method = r.method; rec.liensLus = items.length;
    } else {
      let pages = [src.url];
      if (src.type === 'D') {
        const { links, method } = await getLinks(src.url);
        const cand = [...new Set(links.filter(l => /carri[èe]re|emploi|offres? d|recrut|travailler|join us|careers?|jobs?\b|nous joindre à|rejoignez/i.test(l.text + ' ' + l.href) && !/facebook|linkedin|instagram|twitter|youtube/i.test(l.href)).map(l => l.href))].slice(0, 3);
        rec.decouverts = cand; if (!cand.length) { rec.status = 'vide'; rec.note = 'aucune page carrières/emploi trouvée sur la page d\'accueil (' + method + ')'; return rec; }
        pages = cand;
      }
      let all = [], methods = [];
      for (const p of pages) { try { const { links, method } = await getLinks(p); all.push(...links); methods.push(method); } catch (e) { rec.note = (rec.note ? rec.note + ' ; ' : '') + e.message; } }
      rec.method = [...new Set(methods)].join('+'); rec.liensLus = all.length;
      if (!all.length) throw new Error(rec.note || 'aucune donnée');
      const uniq = new Map(); for (const l of all) { if (!l.text || l.text.length < 10 || l.text.length > 220 || GENERIC.test(l.text) || NAV.test(l.text)) continue; const ok = triage(src, l); if (ok) { const h = l.href.replace(/;jsessionid=[^?]*/i, ''); uniq.set(h + l.text, { text: l.text, href: h }); } }
      items = [...uniq.values()];
    }
    rec.retenus = items.length;
    rec.nouveaux = record(src, items, true);
    rec.status = items.length ? 'ok' : (rec.liensLus ? 'aucun poste' : 'vide');
  } catch (e) { rec.status = 'echec'; rec.erreur = String(e.message).slice(0, 300); }
  return rec;
}

// Portail Oracle iRecruitment de la Ville de Montréal (navigateur requis; liens liés à la session -> on relève titre + numéro)
async function oracleMtl(url) {
  const b = await getBrowser(); const ctx = await b.newContext({ userAgent: UA, locale: 'fr-CA' }); const page = await ctx.newPage();
  const items = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const cats = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => (a.innerText || '').trim()).filter(t => /professionnel|directeur|gestionnaire|cadre|conseiller|chef/i.test(t)));
    const seenCats = new Set();
    const tryCollect = async () => {
      for (let pg = 0; pg < 15; pg++) {
        const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map(tr => ({ text: (tr.innerText || '').replace(/\s+/g, ' ').trim(), href: (tr.querySelector('a[href]') || {}).href || '' })).filter(r => r.text.length > 20));
        for (const r of rows) if (/[A-Z]{2,6}-\d{2}-[A-Z]+-\d+/.test(r.text) || /(conseill|chef|commissaire|agent|charg|analyste|gestionnaire|directeur|coordonn)/i.test(r.text)) items.push({ text: r.text.slice(0, 200), href: r.href || url });
        const next = page.locator('a:has-text("Suivant"), a:has-text("Next"), a[title*="Suivant"]').first();
        if (!(await next.count())) break; await next.click().catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); await sleep(600);
      }
    };
    const searchBtn = page.locator('button:has-text("Rechercher"), input[value*="Rechercher"], a:has-text("Rechercher")').first();
    if (await searchBtn.count()) { await searchBtn.click().catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await tryCollect(); }
    for (const c of cats) { if (seenCats.has(c)) continue; seenCats.add(c); await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); const l = page.locator('a', { hasText: c }).first(); if (await l.count()) { await l.click().catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await tryCollect(); } }
  } finally { await ctx.close(); }
  const uniq = new Map(); for (const i of items) uniq.set(i.text, i);
  return { items: [...uniq.values()], method: 'navigateur (Oracle)' };
}

// Exécution avec concurrence limitée
const queue = [...CFG];
async function worker() { while (queue.length) { const s = queue.shift(); const r = await Promise.race([runSource(s), new Promise(res => setTimeout(() => res({ type: s.type, url: s.url, status: 'echec', erreur: 'délai dépassé (4 min)' }), 240000))]); sante[s.name] = r; console.log(`[${r.status}] ${s.name} ${r.method || ''} lus=${r.liensLus ?? '-'} retenus=${r.retenus ?? '-'} nouveaux=${r.nouveaux ?? '-'} ${r.erreur || r.note || ''}`); } }
await Promise.all([worker(), worker(), worker(), worker()]);
// Seconde passe: reprend les sources en échec ou vides après une pause
{
  const redo = Object.entries(sante).filter(([, r]) => r.status === 'echec' || r.status === 'vide').map(([n]) => CFG.find(c => c.name === n)).filter(Boolean);
  if (redo.length) {
    console.log('Seconde passe: ' + redo.length + ' source(s) à reprendre');
    await new Promise(r => setTimeout(r, 20000));
    queue.push(...redo);
    await Promise.all([worker(), worker()]);
    for (const c of redo) if (sante[c.name]) sante[c.name].reprise = true;
  }
}
if (browser) await browser.close();

// Enrichissement: ouvre chaque nouvelle offre (HTTP simple) et en tire employeur, lieu, salaire, échéance, aperçu
const SKIP_ENR = /indeed\.|linkedin\.|glassdoor\.|myworkdayjobs\./i;
async function enrich(n) {
  if (SKIP_ENR.test(n.url)) return;
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(n.url, { headers: { 'user-agent': UA, 'accept-language': 'fr-CA,fr;q=0.9' }, signal: ctl.signal, redirect: 'follow' }); clearTimeout(to);
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return;
    const html = await r.text(); const $ = cheerio.load(html); const e = {};
    const flat = (v) => Array.isArray(v) ? v.flatMap(flat) : (v && v['@graph'] ? flat(v['@graph']) : [v]);
    $('script[type="application/ld+json"]').each((_, el) => { try { for (const o of flat(JSON.parse($(el).contents().text())))
      if (o && /JobPosting/i.test(String(o['@type']))) {
        e.emp = e.emp || (o.hiringOrganization && (o.hiringOrganization.name || o.hiringOrganization)) || undefined;
        const loc = [].concat(o.jobLocation || [])[0]; const a = loc && loc.address; if (a) e.lieu = e.lieu || [a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
        const bs = o.baseSalary && o.baseSalary.value; if (bs) e.sal = e.sal || [bs.minValue, bs.maxValue, bs.value].filter(x => x !== undefined && typeof x !== 'object').join('–') + ' ' + (bs.unitText || '');
        e.echeance = e.echeance || o.validThrough; e.titreOffre = e.titreOffre || o.title;
        if (o.description) e.apercu = e.apercu || cheerio.load('<div>' + o.description + '</div>')('div').text().replace(/\s+/g, ' ').trim().slice(0, 350);
      } } catch {} });
    if (!e.apercu) { const d = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'); if (d) e.apercu = d.replace(/\s+/g, ' ').trim().slice(0, 350); }
    const body = $('body').text().replace(/\s+/g, ' ');
    if (!e.sal) { const m = body.match(/\d{2,3}[  ]?\d{3}\s*\$?\s*(?:à|-|–)\s*\d{2,3}[  ]?\d{3}\s*\$|\d{2,3}[,.]\d{2}\s*\$?\s*(?:à|-|–)\s*\d{2,3}[,.]\d{2}\s*\$|salaire[^.]{0,80}\d[^.]{0,60}\$/i); if (m) e.sal = m[0].slice(0, 90); }
    if (!e.echeance) { const m = body.match(/(?:date limite|fin d.affichage|jusqu.au|closing date|date de cl[ôo]ture)[^.]{0,60}/i); if (m) e.echeance = m[0].slice(0, 80); }
    if (!e.apercu) e.apercu = body.slice(0, 250);
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === '' ) delete e[k];
    n._st.e = e;
  } catch {}
}
{ const q = [...nouveaux]; const w = async () => { while (q.length) await enrich(q.shift()); }; await Promise.all([w(), w(), w(), w(), w(), w()]); }

const counts = Object.values(sante).reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const recent = [];
for (const [srcName, st] of Object.entries(state)) for (const it of Object.values(st)) if (it.d >= cutoff) recent.push({ source: srcName, titre: it.t, url: it.u, vuLe: it.d, pre: rough(it.t, it.u, srcName), ...(it.e || {}) });
recent.sort((a, b) => b.pre - a.pre || (a.vuLe < b.vuLe ? 1 : -1));
const out = { genereLe: new Date().toISOString(), date: TODAY, sourcesTotal: CFG.length, statuts: counts, nouveauxCeJour: nouveaux.length, nouveauxTotal: recent.length, fenetreJours: 3, nouveaux: recent, disparus, ecartesCeJour: ecartes.size };
fs.writeFileSync('data/nouveautes.json', JSON.stringify(out, null, 1));
fs.writeFileSync('data/sante.json', JSON.stringify({ date: TODAY, statuts: counts, sources: sante }, null, 1));
fs.writeFileSync('data/ecartes.json', JSON.stringify({ date: TODAY, total: ecartes.size, ecartes: [...ecartes.values()] }, null, 1));
fs.writeFileSync('data/state.json', JSON.stringify(state));
console.log('Terminé', JSON.stringify(counts), 'nouveaux', nouveaux.length, 'disparus', disparus.length);
process.exit(0);
