/// <reference lib="es2022" />
/**
 * Generate isolated AI/Agent pre-classification proposals for screens that
 * currently only have a top-level major (e.g., 新UI / 未細分).
 *
 * Writes ONLY to labels/projects/<projectId>/proposals.json — never modifies
 * formal screens-v2.json labels until the designer confirms in the Review Workbench.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database = require('better-sqlite3');
import { archetypeOf, findScreenRootCandidates, Graph, headlineOf } from './core/graph';
import { loadProposals, resolveProject, saveProposals, type LabelProposalItem, type ProposalsDoc } from './core/projects';
import { tryLoadScreenLabelsV2 } from './core/semantics';

const ROOT = resolve(__dirname, '..');

export interface GenerateProposalsOptions {
  projectId?: string;
  dbPath?: string;
}

export interface GenerateProposalsResult {
  projectId: string;
  path: string;
  total: number;
  high: number;
  medium: number;
  low: number;
}

function inferBySemantics(
  name: string,
  headline: string,
  archetype: string,
  pageName: string,
  allowedNewMinors: Set<string>,
  allowedSysMinors: Set<string>,
): { major: string; minor: string; generation: string; reason: string } | null {
  const hay = (name + ' ' + headline).toLowerCase();
  const pickNew = (minor: string, reason: string) =>
    allowedNewMinors.has(minor) ? { major: '新UI', minor, generation: 'new', reason } : null;
  const pickSys = (minor: string, reason: string) =>
    allowedSysMinors.has(minor) ? { major: '系統UI', minor, generation: '', reason } : null;

  if (/system\s*call|系统弹窗|系統彈窗|permission|權限|权限/.test(hay)) {
    return pickSys('系統彈窗', '圖層或文案含系統權限／系統彈窗特徵');
  }
  if (/toast/i.test(name)) {
    return pickNew('Toast', '圖層命名為 Toast 輕提示');
  }
  if (/face\s*id|人脸|人臉/.test(hay) && archetype !== 'page') {
    return pickNew('FaceID彈窗', '文案／圖層涉及 FaceID 或人臉辨識彈窗');
  }
  if (/fingerprint|指紋|指纹|biometric/.test(hay) && archetype !== 'page') {
    return pickNew('指紋確認彈窗', '文案／圖層涉及生物辨識指紋確認');
  }
  if (/dialog|popup|modal|彈窗|弹窗/.test(name.toLowerCase())) {
    return pickNew('通用彈窗', '圖層命名為 Dialog／彈窗');
  }
  if (/drawer|sheet|抽屜|抽屉|filter/.test(name.toLowerCase()) && archetype !== 'page') {
    return pickNew('下拉抽屜彈窗', '圖層或原型為底部抽屜／篩選面板');
  }
  if (/payment result|支付結果|支付结果|result page|交易結果|交易结果/.test(hay)) {
    return pickNew('交易結果頁', '圖層／文案符合支付或交易結果頁');
  }
  if (/transaction detail|交易詳情|交易详情/.test(hay)) {
    return pickNew('交易詳情', '圖層／文案包含交易詳情特徵');
  }
  if (/transaction history|交易歷史|交易历史|recent transactions/.test(hay)) {
    return pickNew('交易歷史記錄', '圖層／文案為交易紀錄列表');
  }
  if (/cashier|收銀台|收银台|select payment method|選支付方式|选支付方式/.test(hay)) {
    return pickNew('收銀台', '圖層或頁面文案符合收銀台／選擇支付方式');
  }
  if (/home\s*page|首頁|首页/.test(name.toLowerCase())) {
    return pickNew('首頁', '圖層命名為首頁／Home Page');
  }
  if (/welcome|wlecome|歡迎|欢迎|launch/.test(name.toLowerCase())) {
    return pickNew('Welcome 歡迎頁', '圖層命名為歡迎頁／啟動頁');
  }
  if (/my account|account page|個人中心|个人中心/.test(name.toLowerCase())) {
    return pickNew('個人中心', '圖層命名為個人中心／帳戶頁');
  }
  if (/notification|消息|通知|inbox/.test(name.toLowerCase())) {
    return pickNew('消息通知類', '圖層命名屬於消息通知中心');
  }
  if (/get help|help center|幫助|帮助|support|客服/.test(hay)) {
    return pickNew('幫助中心', '圖層／文案屬於幫助與客服中心');
  }
  if (/nfc setting/.test(name.toLowerCase())) {
    return pickNew('NFC 設置頁', '圖層命名為 NFC 設置步驟頁');
  }
  if (/tap\s*&\s*pay|t&p/.test(name.toLowerCase())) {
    return pickNew('Tap&Pay 陣地頁', '圖層命名為 Tap&Pay 主陣地頁');
  }
  if (/otp|驗證碼|验证码/.test(name.toLowerCase())) {
    return archetype === 'page'
      ? pickNew('OTP驗證', '圖層為 OTP 驗證頁面')
      : pickNew('OTP彈窗', '圖層為 OTP 驗證彈窗');
  }
  if (/pin/.test(name.toLowerCase()) && /reset|change|set|pin/.test(pageName.toLowerCase())) {
    return archetype === 'page'
      ? pickNew('設置PIN', '頁面與圖層符合 PIN 設置流程')
      : pickNew('PIN確認彈窗', '彈窗層級符合 PIN 確認彈窗');
  }
  if (/kyc/.test((name + ' ' + pageName).toLowerCase())) {
    return /upgrade|升級|升级/.test(hay)
      ? pickNew('KYC 升級', '頁面／文案涉及 KYC 升級')
      : pickNew('KYC', '頁面／圖層屬於 KYC 身份認證流程');
  }
  if (/register|registration|sign up|註冊|注册/.test((name + ' ' + pageName).toLowerCase())) {
    return pickNew('註冊頁面', '頁面／圖層屬於註冊流程');
  }
  if (/phone number|手機號|手机号/.test((name + ' ' + pageName).toLowerCase())) {
    return pickNew('輸入手機號頁面', '頁面／圖層屬於輸入手機號流程');
  }
  if (/ai assistant|ai chat/.test(pageName.toLowerCase())) {
    return pickNew('AI Chat頁面', '位於 AI Assistant 頁面');
  }
  if (/reward/.test(pageName.toLowerCase()) && /reward|point|prize/.test(hay)) {
    return pickNew('Rewards 列表', '位於 Rewards 頁面且文案相符');
  }
  if (/coupon|voucher|券/.test((name + ' ' + pageName).toLowerCase())) {
    return pickNew('券列表', '頁面／圖層屬於優惠券列表');
  }
  if (/bank card|card/.test(pageName.toLowerCase()) && /card|bank/.test(hay)) {
    return pickNew('卡管理頁', '位於銀行卡頁面且含卡片操作文案');
  }
  if (/payment preference/.test(pageName.toLowerCase())) {
    return pickNew('支付方式偏好選擇', '位於 Payment Preference 頁面');
  }
  if (/bsc|csb|qr|scan/.test(pageName.toLowerCase()) && /qr|scan|code|pay/.test(hay)) {
    return pickNew('掃碼收款/支付', '位於掃碼收付款流程頁面且含二維碼文案');
  }
  if (/p2p|send money|split bill/.test(pageName.toLowerCase())) {
    if (/friend|contact|好友/.test(hay)) return pickNew('選擇好友', '位於轉帳／分帳頁面且含聯絡人選擇文案');
    if (/amount|send|transfer|split/.test(hay)) return pickNew('Send Money', '位於 P2P／分帳頁面且含轉帳金額文案');
  }
  if (archetype === 'overlay-panel') {
    return pickNew('通用彈窗', '原型檢測為浮層面板（overlay-panel）');
  }
  if (archetype === 'overlay') {
    return pickNew('下拉抽屜彈窗', '原型檢測為遮罩抽屜層（overlay）');
  }
  return null;
}

export function generateProposals(opts: GenerateProposalsOptions = {}): GenerateProposalsResult {
  const resolved = resolveProject(ROOT, { project: opts.projectId, dbPath: opts.dbPath });
  if (!resolved.dbPath || !existsSync(resolved.dbPath)) {
    throw new Error('no database found; run the Figma extraction first');
  }

  const v2Doc = tryLoadScreenLabelsV2(resolved.labelsPath);
  if (!v2Doc || v2Doc.screens.length === 0) {
    throw new Error('no existing v2 labels found at ' + resolved.labelsPath);
  }

  const g = new Graph(resolved.dbPath);
  const db = new Database(resolved.dbPath, { readonly: true, fileMustExist: true });
  const pageMeta = new Map<string, string>();
  try {
    for (const row of db.prepare('SELECT page_id, page_name FROM pages').all() as Array<{ page_id: string; page_name: string }>) {
      pageMeta.set(row.page_id, row.page_name);
    }
  } finally {
    db.close();
  }

  const allRoots = findScreenRootCandidates(g, resolved.config.screenSpec);
  const rootSet = new Set(allRoots);

  const allowedNewMinors = new Set<string>();
  const allowedSysMinors = new Set<string>();
  const hashPeers = new Map<string, Map<string, number>>();

  for (const s of v2Doc.screens) {
    if (s.major === '新UI' && s.minor) {
      allowedNewMinors.add(s.minor);
    } else if (s.major === '系統UI' && s.minor) {
      allowedSysMinors.add(s.minor);
    }
    if ((s.major === '新UI' || s.major === '系統UI') && s.minor && s.minor !== '廢棄') {
      const h = g.hash.get(s.id);
      if (!h) continue;
      const bucketKey = s.major + '::' + s.minor;
      let mp = hashPeers.get(h);
      if (!mp) {
        mp = new Map<string, number>();
        hashPeers.set(h, mp);
      }
      mp.set(bucketKey, (mp.get(bucketKey) ?? 0) + 1);
    }
  }

  const prevDoc = loadProposals(ROOT, resolved.id);
  const prevById = new Map((prevDoc?.items ?? []).map((it) => [it.id, it]));

  const items: LabelProposalItem[] = [];
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const s of v2Doc.screens) {
    if (s.major !== '新UI' || (s.minor && s.minor.trim().length > 0)) continue;
    const node = g.nodes.get(s.id);
    if (!node) continue;

    const sub = g.subtree(s.id);
    if (sub.length < resolved.config.screenSpec.minNodes && !rootSet.has(s.id)) continue;

    const texts: string[] = [];
    for (const sid of sub) {
      const t = g.nodes.get(sid)?.text_content;
      if (t) texts.push(t);
    }
    const headline = headlineOf(texts);
    const arch = archetypeOf(g, s.id);
    const pgName = (pageMeta.get(node.page_id) ?? node.page_name ?? '').trim();
    const h = g.hash.get(s.id) ?? '';
    const peerCounts = h ? hashPeers.get(h) : undefined;

    if (peerCounts && peerCounts.size === 1) {
      const [[bucketKey, cnt]] = [...peerCounts.entries()];
      const [sMaj, sMin] = bucketKey.split('::');
      items.push({
        id: s.id,
        currentMajor: s.major,
        currentMinor: s.minor || '',
        currentGeneration: s.generation || 'new',
        suggestedMajor: sMaj,
        suggestedMinor: sMin,
        suggestedGeneration: sMaj === '系統UI' ? '' : 'new',
        confidence: 'high',
        reason: 'AST 結構與已標註的「' + sMaj + ' / ' + sMin + '」（' + cnt + ' 筆）完全相同',
        source: 'ast-exact',
      });
      high += 1;
      continue;
    }

    if (peerCounts && peerCounts.size > 1) {
      const sorted = [...peerCounts.entries()].sort((a, b) => b[1] - a[1]);
      const totalPeers = sorted.reduce((acc, x) => acc + x[1], 0);
      const [topKey, topCnt] = sorted[0];
      if (topCnt >= 2 && topCnt / totalPeers >= 0.8) {
        const [sMaj, sMin] = topKey.split('::');
        items.push({
          id: s.id,
          currentMajor: s.major,
          currentMinor: s.minor || '',
          currentGeneration: s.generation || 'new',
          suggestedMajor: sMaj,
          suggestedMinor: sMin,
          suggestedGeneration: sMaj === '系統UI' ? '' : 'new',
          confidence: 'medium',
          reason: 'AST 同構多數（' + topCnt + '/' + totalPeers + ' 筆）歸為「' + sMaj + ' / ' + sMin + '」',
          source: 'ast-family',
        });
        medium += 1;
        continue;
      }
    }

    const heur = inferBySemantics(node.name, headline, arch, pgName, allowedNewMinors, allowedSysMinors);
    if (heur) {
      items.push({
        id: s.id,
        currentMajor: s.major,
        currentMinor: s.minor || '',
        currentGeneration: s.generation || 'new',
        suggestedMajor: heur.major,
        suggestedMinor: heur.minor,
        suggestedGeneration: heur.generation,
        confidence: 'medium',
        reason: heur.reason,
        source: 'heuristic',
      });
      medium += 1;
      continue;
    }

    const prev = prevById.get(s.id);
    if (prev && prev.confidence === 'low' && prev.suggestedMajor) {
      items.push(prev);
      low += 1;
      continue;
    }

    items.push({
      id: s.id,
      currentMajor: s.major,
      currentMinor: s.minor || '',
      currentGeneration: s.generation || 'new',
      suggestedMajor: '',
      suggestedMinor: '',
      suggestedGeneration: 'new',
      confidence: 'low',
      reason: '圖層與文案無明確對應標準子類，請人工由下拉選單拍板',
      source: 'uncertain',
    });
    low += 1;
  }

  const outDoc: ProposalsDoc = {
    version: 1,
    projectId: resolved.id,
    generatedAt: new Date().toISOString(),
    scope: '新UI / (未細分) 細分建議',
    items,
  };
  const outPath = saveProposals(ROOT, resolved.id, outDoc);
  return {
    projectId: resolved.id,
    path: outPath,
    total: items.length,
    high,
    medium,
    low,
  };
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const args = process.argv.slice(2);
  let projectId = '';
  let dbPath = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project') projectId = args[++i] ?? '';
    else if (args[i] === '--db') dbPath = args[++i] ?? '';
  }
  try {
    const res = generateProposals({ projectId: projectId || undefined, dbPath: dbPath || undefined });
    console.log(
      'proposals written · project=' + res.projectId +
      ' total=' + res.total +
      ' high=' + res.high +
      ' medium=' + res.medium +
      ' low=' + res.low +
      ' path=' + res.path,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
