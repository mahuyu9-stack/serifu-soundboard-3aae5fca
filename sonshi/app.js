"use strict";

/*
 * 孫子に聞け app.js
 * サーバーもAPIも使わない完全クライアントサイド実装。
 * 悩みテキストと各一節のタグをキーワードマッチングで採点し、
 * 上位の一節を「孫子ならこう例える」形式で提示する。
 */

// 悩みカテゴリチップ。選ぶとそのキーワード群が採点に加算される。
const CATEGORIES = [
  { label: "仕事・キャリア", keywords: ["転職", "キャリア", "昇進", "評価", "上司", "起業"] },
  { label: "人間関係", keywords: ["人間関係", "苦手な人", "喧嘩", "職場", "合わない", "同僚"] },
  { label: "競争・ライバル", keywords: ["ライバル", "競争", "勝てない", "比べ", "差別化"] },
  { label: "決断・迷い", keywords: ["迷い", "決断", "選択", "どっち", "選べない"] },
  { label: "不安・メンタル", keywords: ["不安", "心配", "焦り", "怒り", "疲れ", "イライラ"] },
  { label: "チーム・部下", keywords: ["部下", "後輩", "チーム", "マネジメント", "指導", "新人"] },
  { label: "恋愛・家庭", keywords: ["片思い", "告白", "夫婦", "パートナー", "子育て", "子ども"] },
  { label: "勉強・成長", keywords: ["勉強法", "試験", "受験", "基礎", "資格", "習慣"] },
];

const selectedCategories = new Set();

// ---------- 悩みマッチング ----------

// タグが長い(=具体的な)ほど高得点にして、汎用語より具体語のヒットを優先する
function scorePassage(passage, text, extraKeywords) {
  let score = 0;
  for (const tag of passage.tags) {
    if (text.includes(tag)) score += 2 + tag.length;
  }
  for (const kw of extraKeywords) {
    if (passage.tags.some((tag) => tag.includes(kw) || kw.includes(tag))) {
      score += 3;
    }
  }
  return score;
}

// 同点の一節は相談のたびに順序が入れ替わるよう、乱数タイブレークを入れる
function findMatches(text, extraKeywords) {
  return SONSHI_PASSAGES
    .map((p) => ({ passage: p, score: scorePassage(p, text, extraKeywords), tie: Math.random() }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.tie - a.tie)
    .map((s) => s.passage);
}

// どのタグにも当たらなかったときに提示する、悩み全般に効く一節のプール
const FALLBACK_IDS = [
  "boukou-chihi",
  "kyuhen-rigai",
  "sakusen-sessoku",
  "gunkei-fukashou",
  "kyojitsu-mizu",
  "kyuhen-tanomu",
];

// 同じ答えでも切り出しが毎回変わるよう、出だし文を数種類用意する
const LEAD_VARIATIONS = [
  "その悩み、孫子の兵法ではこう考えます ―",
  "二千五百年前の軍師の見立てはこうです ―",
  "兵法書をめくると、この局面に効く一節がありました ―",
  "孫子が陣中からあなたに送る答えは ―",
  "その戦況、兵法ではすでに答えが出ています ―",
];

const FALLBACK_LEADS = [
  "ぴったりの一節は見つかりませんでしたが、どんな悩みにも効く節を ―",
  "その悩みに直接答える節はありませんでしたが、軍師の基本はこちら ―",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 直近の相談の候補リストと表示位置。「別の一節で聞き直す」で次の3つに進む。
let consultState = { matches: [], offset: 0, fallback: false };

function consult() {
  const text = document.getElementById("worryInput").value.trim();
  const extraKeywords = [...selectedCategories].flatMap(
    (label) => CATEGORIES.find((c) => c.label === label).keywords
  );

  if (!text && extraKeywords.length === 0) {
    alert("悩みを書くか、悩みの種類を選んでください。");
    return;
  }

  let matches = findMatches(text, extraKeywords);
  let fallback = false;
  if (matches.length === 0) {
    fallback = true;
    matches = FALLBACK_IDS
      .map((id) => SONSHI_PASSAGES.find((p) => p.id === id))
      .sort(() => Math.random() - 0.5);
  }

  consultState = { matches, offset: 0, fallback };
  showConsultResults();
  document.getElementById("resultArea").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showConsultResults() {
  const { matches, offset, fallback } = consultState;
  const picks = matches.slice(offset, offset + 3);

  const list = document.getElementById("resultList");
  list.innerHTML = "";
  picks.forEach((p) => list.appendChild(buildPassageCard(p, true)));

  document.getElementById("resultLead").textContent = fallback
    ? pickRandom(FALLBACK_LEADS)
    : pickRandom(LEAD_VARIATIONS);
  document.getElementById("rerollBtn").hidden = matches.length <= 3;
  document.getElementById("resultArea").hidden = false;
}

// 候補リストの次の3つを表示する。末尾まで来たら先頭に戻る。
function rerollConsult() {
  const next = consultState.offset + 3;
  consultState.offset = next >= consultState.matches.length ? 0 : next;
  showConsultResults();
  document.getElementById("resultArea").scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetConsult() {
  document.getElementById("worryInput").value = "";
  selectedCategories.clear();
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
  document.getElementById("resultArea").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- 一節カードの描画 ----------

function chapterOf(passage) {
  return SONSHI_CHAPTERS.find((c) => c.no === passage.chapter);
}

function buildPassageCard(passage, withAdvice) {
  const chapter = chapterOf(passage);
  const card = document.createElement("article");
  card.className = "passage-card";

  const tag = document.createElement("span");
  tag.className = "passage-chapter";
  tag.textContent = `第${chapter.no}篇 ${chapter.name}`;
  card.appendChild(tag);

  const kanbun = document.createElement("p");
  kanbun.className = "passage-kanbun";
  kanbun.textContent = passage.kanbun;
  card.appendChild(kanbun);

  const yomi = document.createElement("p");
  yomi.className = "passage-yomi";
  yomi.textContent = passage.yomi;
  card.appendChild(yomi);

  const gendaiTitle = document.createElement("p");
  gendaiTitle.className = "passage-section-title";
  gendaiTitle.textContent = "現代語訳";
  card.appendChild(gendaiTitle);

  const gendai = document.createElement("p");
  gendai.className = "passage-gendai";
  gendai.textContent = passage.gendai;
  card.appendChild(gendai);

  if (withAdvice) {
    const adviceTitle = document.createElement("p");
    adviceTitle.className = "passage-section-title";
    adviceTitle.textContent = "あなたの悩みに例えると";
    card.appendChild(adviceTitle);

    const advice = document.createElement("p");
    advice.className = "passage-advice";
    advice.textContent = passage.advice;
    card.appendChild(advice);
  }

  return card;
}

// ---------- 兵法を読むタブ ----------

function renderDailyPassage() {
  // 日付で決まる「今日の一節」。同じ日は何度開いても同じ一節になる。
  const today = new Date();
  const seed = today.getFullYear() * 372 + (today.getMonth() + 1) * 31 + today.getDate();
  const passage = SONSHI_PASSAGES[seed % SONSHI_PASSAGES.length];
  const box = document.getElementById("dailyPassage");
  box.innerHTML = "";
  box.appendChild(buildPassageCard(passage, true));
}

function renderChapterList() {
  const list = document.getElementById("chapterList");
  list.innerHTML = "";

  SONSHI_CHAPTERS.forEach((chapter) => {
    const details = document.createElement("details");

    const summary = document.createElement("summary");
    const no = document.createElement("span");
    no.className = "chapter-no";
    no.textContent = `第${chapter.no}篇`;
    const name = document.createElement("span");
    name.className = "chapter-name";
    name.textContent = chapter.name;
    const desc = document.createElement("span");
    desc.className = "chapter-desc";
    desc.textContent = chapter.desc;
    summary.appendChild(no);
    summary.appendChild(name);
    summary.appendChild(desc);
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "chapter-body";
    const passages = SONSHI_PASSAGES.filter((p) => p.chapter === chapter.no);
    if (passages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chapter-empty";
      empty.textContent = "この篇の収録節は準備中です。";
      body.appendChild(empty);
    } else {
      passages.forEach((p) => body.appendChild(buildPassageCard(p, false)));
    }
    details.appendChild(body);

    list.appendChild(details);
  });
}

// ---------- タブ切り替え ----------

function switchTab(tab) {
  const consultActive = tab === "consult";
  document.getElementById("consultView").hidden = !consultActive;
  document.getElementById("readView").hidden = consultActive;
  document.getElementById("tabConsult").classList.toggle("active", consultActive);
  document.getElementById("tabRead").classList.toggle("active", !consultActive);
  window.scrollTo({ top: 0 });
}

// ---------- 初期化 ----------

function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  CATEGORIES.forEach((category) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.textContent = category.label;
    chip.addEventListener("click", () => {
      if (selectedCategories.has(category.label)) {
        selectedCategories.delete(category.label);
        chip.classList.remove("selected");
      } else {
        selectedCategories.add(category.label);
        chip.classList.add("selected");
      }
    });
    wrap.appendChild(chip);
  });
}

function init() {
  renderCategoryChips();
  renderDailyPassage();
  renderChapterList();

  document.getElementById("askBtn").addEventListener("click", consult);
  document.getElementById("rerollBtn").addEventListener("click", rerollConsult);
  document.getElementById("againBtn").addEventListener("click", resetConsult);
  document.getElementById("tabConsult").addEventListener("click", () => switchTab("consult"));
  document.getElementById("tabRead").addEventListener("click", () => switchTab("read"));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.error("Service Workerの登録に失敗しました", err);
      });
    });
  }
}

init();
