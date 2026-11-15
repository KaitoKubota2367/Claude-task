// LoL 相性ナビ：ランク戦の試合データを Riot API から集めて、
// チャンピオン × レーン × 対面ごとのビルド（ルーン・アイテム順・スキル順）を集計する。
// GitHub Actions から実行する（.github/workflows/lol-matchup-data.yml）。Node 20 以上。
//
// 保存先（DATA_DIR、既定は ./data。lol-data ブランチの中身）
//   state/players.json.gz        対象プレイヤーの一覧（1日ごとに更新）
//   state/acc-<patch>.json.gz    集計途中のカウンター（パッチごと）
//   state/seen-<patch>.json.gz   取り込み済みの試合ID
//   out/index.json               アプリ向けの概要
//   out/status.json              最後の実行結果（エラー確認用）
//   out/champ/<ChampionId>.json  アプリ向けのチャンピオン別ビルド
// 個人を特定できる情報（名前・PUUID）は out/ には一切書き出さない。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const KEY = process.env.RIOT_API_KEY;
const DATA = process.env.DATA_DIR || 'data';
const RUN_MS = (Number(process.env.RUN_MINUTES) || 50) * 60000;
const PLATFORMS = (process.env.PLATFORMS || 'jp1,kr').split(',').map(s => s.trim()).filter(Boolean);
const ROUTING = 'asia'; // JP1・KR の試合データはどちらも asia
const DD = 'https://ddragon.leagueoflegends.com';
const T0 = Date.now();
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const DIMS = ['runes', 'start', 'core', 'boots', 'i4', 'i5', 'i6', 'skill', 'spells'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const timeLeft = () => RUN_MS - (Date.now() - T0);

/* ---------- ファイル ---------- */
const p = (...a) => path.join(DATA, ...a);
function readGz(file, d) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p(file))).toString()); } catch { return d; }
}
function writeGz(file, obj) {
  fs.mkdirSync(path.dirname(p(file)), { recursive: true });
  fs.writeFileSync(p(file), zlib.gzipSync(JSON.stringify(obj)));
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(p(file)), { recursive: true });
  fs.writeFileSync(p(file), JSON.stringify(obj));
}
function readJSON(file, d) {
  try { return JSON.parse(fs.readFileSync(p(file), 'utf8')); } catch { return d; }
}

/* ---------- Riot API（レート制限つき） ---------- */
class AuthError extends Error {}
class Limiter {
  // 個人用・開発用キーの上限は 1秒20回・2分100回（地域ごと）。少し余裕を持たせる。
  constructor(limits) { this.limits = limits; this.hist = []; }
  async wait() {
    for (;;) {
      const now = Date.now();
      this.hist = this.hist.filter(t => now - t < 125000);
      let w = 0;
      for (const [n, win] of this.limits) {
        const inWin = this.hist.filter(t => now - t < win);
        if (inWin.length >= n) w = Math.max(w, inWin[0] + win - now + 100);
      }
      if (!w) { this.hist.push(now); return; }
      await sleep(w);
    }
  }
}
const limiters = {};
let calls = 0;
async function api(region, pathname, tries = 0) {
  const lim = limiters[region] || (limiters[region] = new Limiter([[18, 1000], [95, 120000]]));
  await lim.wait();
  calls++;
  let res;
  try {
    res = await fetch(`https://${region}.api.riotgames.com${pathname}`, { headers: { 'X-Riot-Token': KEY } });
  } catch (e) {
    if (tries < 3) { await sleep(3000); return api(region, pathname, tries + 1); }
    return null;
  }
  if (res.status === 401 || res.status === 403) throw new AuthError(String(res.status));
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after')) || 10;
    log('429 待機', region, ra + 's');
    await sleep(ra * 1000 + 500);
    return tries < 5 ? api(region, pathname, tries + 1) : null;
  }
  if (res.status >= 500) {
    if (tries < 3) { await sleep(2000 * (tries + 1)); return api(region, pathname, tries + 1); }
    return null;
  }
  if (!res.ok) return null; // 404 など
  return res.json();
}

/* ---------- Data Dragon ---------- */
async function dd(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Data Dragon ' + r.status + ' ' + url);
  return r.json();
}
let ITEM = {}, CHAMP_BY_KEY = {};
async function loadStatic() {
  const versions = await dd(`${DD}/api/versions.json`);
  const v = versions[0];
  const [items, champs] = await Promise.all([
    dd(`${DD}/cdn/${v}/data/en_US/item.json`),
    dd(`${DD}/cdn/${v}/data/en_US/champion.json`),
  ]);
  ITEM = items.data;
  for (const c of Object.values(champs.data)) CHAMP_BY_KEY[c.key] = c.id;
  return v.split('.').slice(0, 2).join('.'); // "16.22.1" → "16.22"
}
const isBoots = id => { const it = ITEM[id]; return !!it && (it.tags || []).includes('Boots') && Number(id) !== 1001; };
const isTrinket = id => { const it = ITEM[id]; return !!it && (it.tags || []).includes('Trinket'); };
function isLegendary(id) {
  const it = ITEM[id];
  if (!it || isBoots(id)) return false;
  const tags = it.tags || [];
  if (tags.includes('Consumable') || tags.includes('Trinket')) return false;
  if (it.into && it.into.length) return false;
  return (it.gold && it.gold.total >= 2000);
}

/* ---------- 対象プレイヤー ---------- */
async function loadPlayers() {
  const cached = readGz('state/players.json.gz', null);
  if (cached && Date.now() - cached.t < 24 * 3600e3 && cached.list.length) return cached.list;
  const list = [];
  for (const plat of PLATFORMS) {
    const add = arr => { for (const e of arr || []) if (e && e.puuid) list.push(e.puuid); };
    for (const q of ['challengerleagues', 'grandmasterleagues', 'masterleagues']) {
      const r = await api(plat, `/lol/league/v4/${q}/by-queue/RANKED_SOLO_5x5`);
      add(r && r.entries);
    }
    for (const tier of ['DIAMOND', 'EMERALD']) for (const div of ['I', 'II', 'III', 'IV']) for (const page of [1, 2]) {
      add(await api(plat, `/lol/league/v4/entries/RANKED_SOLO_5x5/${tier}/${div}?page=${page}`));
    }
    log(plat, 'プレイヤー累計', list.length);
  }
  const uniq = [...new Set(list)];
  if (uniq.length) writeGz('state/players.json.gz', { t: Date.now(), list: uniq });
  return uniq;
}

/* ---------- 1試合の取り込み ---------- */
const SLOT = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' };
function newBucket() { const b = { n: 0, w: 0 }; for (const d of DIMS) b[d] = {}; return b; }
function addTo(b, rec, win) {
  b.n++; b.w += win;
  for (const d of DIMS) {
    const k = rec[d];
    if (!k) continue;
    const a = b[d][k] || (b[d][k] = [0, 0]);
    a[0]++; a[1] += win;
  }
}
function runeKey(perks) {
  const st = perks && perks.styles;
  if (!st || st.length < 2) return null;
  const pri = st.find(s => s.description === 'primaryStyle') || st[0];
  const sub = st.find(s => s.description === 'subStyle') || st[1];
  const sp = perks.statPerks || {};
  return `${pri.style}:${pri.selections.map(s => s.perk).join(',')}|${sub.style}:${sub.selections.map(s => s.perk).join(',')}|${[sp.offense, sp.flex, sp.defense].join(',')}`;
}
function ingest(acc, m, tl) {
  const P = m.info.participants;
  const buys = {}, skills = {};
  for (const f of tl.info.frames || []) for (const e of f.events || []) {
    if (e.type === 'ITEM_PURCHASED') (buys[e.participantId] || (buys[e.participantId] = [])).push([e.itemId, e.timestamp]);
    else if (e.type === 'ITEM_UNDO' && e.beforeId) {
      const b = buys[e.participantId];
      if (b) for (let i = b.length - 1; i >= 0; i--) if (b[i][0] === e.beforeId) { b.splice(i, 1); break; }
    } else if (e.type === 'SKILL_LEVEL_UP' && e.levelUpType === 'NORMAL') {
      (skills[e.participantId] || (skills[e.participantId] = [])).push(SLOT[e.skillSlot] || '?');
    }
  }
  // タイムラインの participantId は 1〜10。試合データの participantId と同じ番号。
  for (const pl of P) {
    const pos = pl.teamPosition;
    if (!POSITIONS.includes(pos)) continue;
    const champ = CHAMP_BY_KEY[pl.championId];
    if (!champ) continue;
    const opp = P.find(o => o.teamId !== pl.teamId && o.teamPosition === pos);
    const oppChamp = opp && CHAMP_BY_KEY[opp.championId];
    const b = buys[pl.participantId] || [];
    const start = b.filter(([id, t]) => t < 60000 && !isTrinket(id)).map(([id]) => id).sort((x, y) => x - y);
    const legend = [];
    for (const [id] of b) if (isLegendary(id) && !legend.includes(id)) legend.push(id);
    const bootsBuys = b.filter(([id]) => isBoots(id));
    const sk = skills[pl.participantId] || [];
    const rec = {
      runes: runeKey(pl.perks),
      start: start.length ? start.join(',') : null,
      core: legend.length >= 3 ? legend.slice(0, 3).join('>') : null,
      boots: bootsBuys.length ? String(bootsBuys[bootsBuys.length - 1][0]) : null,
      i4: legend[3] ? String(legend[3]) : null,
      i5: legend[4] ? String(legend[4]) : null,
      i6: legend[5] ? String(legend[5]) : null,
      skill: sk.length >= 15 ? sk.slice(0, 15).join('') : null,
      spells: [pl.summoner1Id, pl.summoner2Id].sort((x, y) => x - y).join(','),
    };
    const win = pl.win ? 1 : 0;
    const c = acc.c[champ] || (acc.c[champ] = {});
    const cp = c[pos] || (c[pos] = { all: newBucket(), vs: {} });
    addTo(cp.all, rec, win);
    if (oppChamp) addTo(cp.vs[oppChamp] || (cp.vs[oppChamp] = newBucket()), rec, win);
  }
  acc.matches++;
}

/* ---------- アプリ向けの書き出し ---------- */
// 勝率は試合数が少ないとぶれるので、全体の勝率に寄せて（ベイズ平均）から並べる。
// さらに、そのバケツの3%未満しか使われていない構成は「勝率が高い」候補から外す。
function top(dim, bn, bw, k) {
  const base = bn ? bw / bn : 0.5;
  const min = Math.max(3, bn * 0.03);
  let rows = Object.entries(dim).map(([key, [n, w]]) => ({ key, n, w, s: (w + 10 * base) / (n + 10) }));
  const ok = rows.filter(r => r.n >= min);
  rows = ok.length ? ok.sort((a, b) => b.s - a.s) : rows.sort((a, b) => b.n - a.n);
  return rows.slice(0, k).map(r => [r.key, r.n, r.w]);
}
function summary(b) {
  const o = { n: b.n, w: b.w };
  const K = { runes: 3, start: 3, core: 4, boots: 3, i4: 4, i5: 4, i6: 4, skill: 3, spells: 2 };
  for (const d of DIMS) o[d] = top(b[d], b.n, b.w, K[d]);
  return o;
}
function mergeBucket(a, b) {
  const o = newBucket();
  for (const x of [a, b]) {
    if (!x) continue;
    o.n += x.n; o.w += x.w;
    for (const d of DIMS) for (const [k, [n, w]] of Object.entries(x[d] || {})) {
      const t = o[d][k] || (o[d][k] = [0, 0]); t[0] += n; t[1] += w;
    }
  }
  return o;
}
function mergeAcc(a, b) {
  const o = { matches: a.matches + b.matches, c: {} };
  for (const src of [a, b]) for (const [ch, poss] of Object.entries(src.c)) for (const [pos, cp] of Object.entries(poss)) {
    const c = o.c[ch] || (o.c[ch] = {});
    const t = c[pos] || (c[pos] = { all: newBucket(), vs: {} });
    t.all = mergeBucket(t.all, cp.all);
    for (const [opp, vb] of Object.entries(cp.vs)) t.vs[opp] = mergeBucket(t.vs[opp], vb);
  }
  return o;
}
function publish(acc, patch, note) {
  const dir = p('out/champ');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const champs = {};
  for (const [ch, poss] of Object.entries(acc.c)) {
    const out = { patch, pos: {} };
    for (const [pos, cp] of Object.entries(poss)) {
      if (cp.all.n < 5) continue;
      const vs = {};
      for (const [opp, vb] of Object.entries(cp.vs)) if (vb.n >= 8) vs[opp] = summary(vb);
      out.pos[pos] = { ...summary(cp.all), vs };
    }
    if (!Object.keys(out.pos).length) continue;
    champs[ch] = Object.fromEntries(Object.entries(out.pos).map(([k, v]) => [k, v.n]));
    fs.writeFileSync(path.join(dir, ch + '.json'), JSON.stringify(out));
  }
  writeJSON('out/index.json', {
    patch, updated: new Date().toISOString(), matches: acc.matches, regions: PLATFORMS,
    tiers: 'EMERALD+', note, champs,
  });
}

/* ---------- 本体 ---------- */
async function main() {
  const status = { ok: false, at: new Date().toISOString(), newMatches: 0, calls: 0, message: '' };
  try {
    if (!KEY) throw new AuthError('no key');
    const patch = await loadStatic();
    log('パッチ', patch);
    const acc = readGz(`state/acc-${patch}.json.gz`, { matches: 0, c: {} });
    const seen = new Set(readGz(`state/seen-${patch}.json.gz`, []));
    const players = await loadPlayers();
    log('プレイヤー', players.length, '取り込み済み試合', acc.matches);
    if (!players.length) throw new Error('プレイヤー一覧を取得できませんでした');

    const since = Math.floor((Date.now() - 4 * 864e5) / 1000);
    const order = players.slice().sort(() => Math.random() - 0.5);
    let otherPatch = 0;
    outer:
    for (const puuid of order) {
      if (timeLeft() < 60000) break;
      const ids = await api(ROUTING, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&start=0&count=20&startTime=${since}`);
      for (const id of ids || []) {
        if (timeLeft() < 60000) break outer;
        if (seen.has(id)) continue;
        seen.add(id);
        const m = await api(ROUTING, `/lol/match/v5/matches/${id}`);
        if (!m || !m.info) continue;
        if (!String(m.info.gameVersion).startsWith(patch + '.')) { otherPatch++; continue; }
        if (m.info.gameDuration < 600 || m.info.participants.some(x => x.gameEndedInEarlySurrender)) continue;
        const tl = await api(ROUTING, `/lol/match/v5/matches/${id}/timeline`);
        if (!tl || !tl.info) continue;
        ingest(acc, m, tl);
        status.newMatches++;
        if (status.newMatches % 50 === 0) log('新規', status.newMatches, '累計', acc.matches, 'API', calls);
      }
    }
    log('完了 新規', status.newMatches, '累計', acc.matches, '別パッチ', otherPatch);

    writeGz(`state/acc-${patch}.json.gz`, acc);
    writeGz(`state/seen-${patch}.json.gz`, [...seen]);
    // 古いパッチの集計は、直前の1つだけ残して削除
    const prevFiles = fs.readdirSync(p('state')).filter(f => /^acc-[\d.]+\.json\.gz$/.test(f) && f !== `acc-${patch}.json.gz`)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const f of prevFiles.slice(1)) fs.rmSync(p('state', f));
    for (const f of fs.readdirSync(p('state')).filter(f => /^seen-/.test(f) && f !== `seen-${patch}.json.gz`)) fs.rmSync(p('state', f));

    // パッチ直後でデータが少ないときは、前のパッチの集計も合わせて使う
    let outAcc = acc, note = '';
    if (acc.matches < 3000 && prevFiles[0]) {
      const prev = readGz('state/' + prevFiles[0], null);
      if (prev) { outAcc = mergeAcc(acc, prev); note = `前パッチ（${prevFiles[0].slice(4, -8)}）のデータを含みます`; }
    }
    publish(outAcc, patch, note);
    status.ok = true;
    status.patch = patch;
    status.totalMatches = acc.matches;
    status.message = 'OK';
  } catch (e) {
    status.message = e instanceof AuthError
      ? 'APIキーが無効か期限切れです（開発用キーは24時間で切れます）。GitHub の Secrets の RIOT_API_KEY を新しいキーに更新してください。'
      : 'エラー: ' + (e && e.message || e);
    log(status.message);
  }
  status.calls = calls;
  status.minutes = Math.round((Date.now() - T0) / 6000) / 10;
  writeJSON('out/status.json', status);
  if (!status.ok) process.exitCode = 1;
}
main();
