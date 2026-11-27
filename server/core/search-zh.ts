/// <reference lib="es2022" />
/**
 * Simplified/Traditional Chinese insensitive & multi-token search helpers.
 * Shared identically between Node verification tests and inline browser scripts
 * inside review-board.ts and review-hub.ts.
 */

// Whitespace-separated 2-character [Traditional][Simplified] pairs.
const T2S_PAIR_STRING = [
  '個个 傳传 冊册 動动 對对 導导 屜屉 帳账 賬账 幫帮 廢废 彈弹 掃扫 擇择 攝摄 棄弃 機机',
  '歡欢 歷历 測测 確确 碼码 紋纹 級级 結结 統统 舊旧 號号 記记 設设 註注 詳详 認认 證证 載载',
  '輸输 選选 銀银 錄录 陣阵 頁页 類类 驗验 吳吴 鵬鹏 錢钱 轉转 綁绑 換换 購购 買买 賣卖 餘余',
  '總总 覽览 檢检 視视 篩筛 歸归 檔档 實实 體体 點点 擊击 條条 項项 報报 畫画 區区 塊块 組组',
  '樣样 護护 國国 際际 運运 營营 銷销 禮礼 紅红 數数 據据 顯显 頭头 編编 輯辑 刪删 處处 態态',
  '靜静 無无 內内 話话 異异 開开 關关 備备 資资 產产 額额 幣币 語语 請请 問问 錯错 誤误 網网',
  '絡络 進进 簽签 權权 聯联 繫系 優优 獎奖 鍵键 盤盘 單单 隱隐 圖图 層层 標标 題题 說说 寫写',
  '複复 製制 貼贴 併并 獨独 規规 則则 範范 圍围 寬宽 長长 頻频 訊讯 郵邮 電电 費费 稅税 匯汇',
  '兌兑 貸贷 還还 儲储 續续 訂订 閱阅 贊赞 評评 論论 訪访 詢询 調调 適适 風风 險险 審审 駁驳',
  '過过 達达 鏈链 躍跃 納纳 採采 暫暂 補补 釋释 鎖锁 啟启 閉闭 觸触 發发 變变 響响 應应 側侧',
  '邊边 欄栏 鈕钮 顏颜 間间 齊齐 陰阴 圓圆 線线 漸渐 專专 屬属 庫库 倉仓 尋寻 濾滤 縮缩 摺折',
  '疊叠 創创 繼继 試试 戶户 現现 敗败 積积 勵励 饋馈 協协 議议 於于 氣气 輕轻 輪轮 籤签 時时',
  '維维 臉脸 聲声 凍冻 訴诉 質质 業业 門门 員员 計计 趨趋 勢势 佈布 暱昵 稱称 簡简 駕驾 夾夹',
  '壓压 預预 橫横 豎竖 淺浅 膚肤 連连 離离 緩缓 麥麦 藍蓝 懸悬 鼠鼠 滾滚 雙双 準准 節节 譜谱',
  '細细 裡里 裏里 後后 麼么 為为 與与 這这 沒没 從从 來来 讓让 給给 將将 雖虽 會会 須须 該该',
  '見见 筆笔 張张 僅仅 當当 斷断 臺台 萬万 億亿 兩两 眾众 兒儿 黨党 剛刚 劇剧 劑剂 務务 勞劳',
  '場场 夢梦 夠够 學学 師师 帶带 廣广 強强 徑径 憑凭 愛爱 慣惯 戰战 戲戏 擁拥 擔担 擬拟 擠挤',
  '擴扩 擺摆 擾扰 書书 橋桥 滿满 漢汉 潔洁 潛潜 燈灯 環环 盡尽 監监 競竞 穩稳 純纯 紙纸 紛纷',
  '經经 綜综 綠绿 綱纲 綴缀 締缔 緣缘 縫缝 績绩 織织 繞绕 繪绘 繳缴 罰罚 習习 職职 聽听 肅肃',
  '脈脉 脫脱 腦脑 腳脚 臨临 興兴 舉举 艦舰 蘇苏 蘋苹 葉叶 藥药 虛虚 虧亏 裝装 親亲 覺觉 觀观',
  '許许 詞词 誇夸 誰谁 談谈 諸诸 譯译 讚赞 負负 財财 貢贡 貧贫 貨货 責责 貴贵 賞赏 賠赔 賴赖',
  '賺赚 賽赛 贈赠 贏赢 趕赶 辭辞 違违 遠远 鄧邓 醫医 針针 錦锦 鏡镜 階阶 隨随 難难 雜杂 頂顶',
  '順顺 領领 顆颗 飛飞 館馆 馬马',
].join(' ');

export const ZH_T2S_MAP: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const pair of T2S_PAIR_STRING.split(/\s+/)) {
    const chars = Array.from(pair);
    if (chars.length === 2 && chars[0] !== chars[1]) {
      map[chars[0]] = chars[1];
    }
  }
  return map;
})();

export function normSearchText(text: string): string {
  const s = String(text ?? '').toLowerCase().replace(/\u3000/g, ' ');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    out += ZH_T2S_MAP[ch] || ch;
  }
  return out;
}

export function matchesSearch(haystack: string, rawQuery: string): boolean {
  const q = normSearchText(rawQuery).trim();
  if (!q) return true;
  const hay = normSearchText(haystack);
  const tokens = q.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] && hay.indexOf(tokens[i]) === -1) return false;
  }
  return true;
}

/** Emits browser-safe ES2020 JS defining `normSearchText` and `matchesSearch`. */
export function buildInlineSearchZhJs(): string {
  const json = JSON.stringify(ZH_T2S_MAP);
  return [
    'const ZH_T2S_MAP = ' + json + ';',
    'function normSearchText(text) {',
    '  const s = String(text == null ? "" : text).toLowerCase().replace(/\\u3000/g, " ");',
    '  let out = "";',
    '  for (let i = 0; i < s.length; i += 1) {',
    '    const ch = s[i];',
    '    out += ZH_T2S_MAP[ch] || ch;',
    '  }',
    '  return out;',
    '}',
    'function matchesSearch(haystack, rawQuery) {',
    '  const q = normSearchText(rawQuery).trim();',
    '  if (!q) return true;',
    '  const hay = normSearchText(haystack);',
    '  const tokens = q.split(/\\s+/);',
    '  for (let i = 0; i < tokens.length; i += 1) {',
    '    if (tokens[i] && hay.indexOf(tokens[i]) === -1) return false;',
    '  }',
    '  return true;',
    '}',
  ].join('\n');
}
