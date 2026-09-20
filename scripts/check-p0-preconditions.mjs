#!/usr/bin/env node
/**
 * G-PRE pre-work check: did V1–V10 actually land?
 *
 * This is a MECHANICAL check, not a quality review. It answers exactly one
 * question per item — "was it changed?" — and never "was it changed well?".
 * That distinction is the whole point of `docs/ruling-d1-d5-oracle.md` §4.4:
 * a patch re-verification and an overall-execution verdict are different
 * conclusions, and this script is only licensed to produce the former.
 *
 * Each V-item is judged against ITS OWN expected exit code (the plan's P-12
 * discipline), so a check that is *supposed* to find an absence passes when the
 * absence is confirmed.
 *
 * Usage:
 *   node scripts/check-p0-preconditions.mjs            # all items
 *   node scripts/check-p0-preconditions.mjs --list     # item ids only
 *
 * Exit codes:
 *   0  every V-item reached its own expected verdict
 *   1  at least one item did not
 *   2  usage / missing input file
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = join(ROOT, "docs/plan-0.8.0-execution.md");
const CONTRACT = join(ROOT, "docs/plan-0.8.0-delivery-layer.md");
const GATE2 = join(ROOT, "docs/gate-round2-fixes.md");
const EXPLAINER = join(ROOT, "docs/explainer-delivery-layer.md");
const RULING = join(ROOT, "docs/ruling-d1-d5-oracle.md");
const LEDGER = join(ROOT, "docs/review-rounds-ledger.md");

/** Read a file, or throw a usage error the caller can act on. */
function must(path) {
  if (!existsSync(path)) throw new Error(`missing input file: ${path}`);
  return readFileSync(path, "utf8");
}

/** 1-based line numbers of lines matching a predicate. */
function linesOf(text, predicate) {
  const out = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i += 1) if (predicate(rows[i])) out.push(i + 1);
  return out;
}

const files = {};
function reload() {
  files.plan = must(PLAN);
  files.contract = must(CONTRACT);
  files.gate2 = must(GATE2);
  files.explainer = must(EXPLAINER);
  files.ruling = must(RULING);
  files.ledger = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "";
}

/**
 * V1–V10. `check` returns {ok, detail}. `expected` is documented for readers;
 * every item here expects `ok === true`, but the verdicts are per-item so a
 * failing item is reported by ID rather than collapsing the whole run.
 */
const ITEMS = [
  {
    id: "V1",
    title: "P0 scope = D1/D2/D3 + D4 + E1 + E4; E2/E3/F1′ out of P0",
    check() {
      const scope = linesOf(files.plan, (l) => l.includes("[P0: D1 (N7)"));
      if (scope.length === 0) return { ok: false, detail: "P0 bracket line not found" };
      const line = files.plan.split("\n")[scope[0] - 1];
      const good = line.includes("E1") && line.includes("E4") &&
        !/\bE2\b/.test(line) && !/\bE3\b/.test(line) && !line.includes("F1′");
      // G-P0 item ⑧ must no longer carry the E-group/F1′ assertion
      const gpo = linesOf(files.plan, (l) => l.includes("G-P0（事实层）"));
      const gpoLine = gpo.length ? files.plan.split("\n")[gpo[0] - 1] : "";
      const gpoClean = !gpoLine.includes("E2/E3/E4/F1′");
      // stage labels
      const e2 = linesOf(files.plan, (l) => l.includes("| E2 三类请示各有去向"));
      const e3 = linesOf(files.plan, (l) => l.includes("| E3 带默认值的请示"));
      const e2Out = e2.length ? files.plan.split("\n")[e2[0] - 1].includes("未启用 / 后续") : false;
      const e3Out = e3.length ? files.plan.split("\n")[e3[0] - 1].includes("未启用 / 后续") : false;
      return {
        ok: good && gpoClean && e2Out && e3Out,
        detail: `bracket=${good} gpo8_clean=${gpoClean} E2_out=${e2Out} E3_out=${e3Out}`,
        lines: [...scope, ...gpo, ...e2, ...e3],
      };
    },
  },
  {
    id: "V2",
    title: "B-4: delivery dependency absent ⇒ refuse delivery actions, A2A still usable",
    check() {
      const hits = linesOf(files.plan, (l) => l.includes("A2A 不随之失效"));
      const b4 = linesOf(files.plan, (l) => l.includes("| **B-4** |"));
      const detail = b4.length
        ? files.plan.split("\n")[b4[0] - 1].includes("A2A 不随之失效")
        : false;
      return { ok: hits.length >= 1 && detail, detail: `hits=${hits.length} in_B4_row=${detail}`, lines: hits };
    },
  },
  {
    id: "V3",
    title: "tier-0 boundary groups in this batch's regression (G-PRE list)",
    check() {
      const gpre = linesOf(files.plan, (l) => l.includes("G-PRE（开工前一次性闸"));
      const script = linesOf(files.plan, (l) => l.includes("test-tier0-predicate.mjs"));
      const inGpre = gpre.length
        ? files.plan.slice(files.plan.indexOf("G-PRE（开工前一次性闸"), files.plan.indexOf("G-PRE（开工前一次性闸") + 2000).includes("test-tier0-predicate.mjs")
        : false;
      return { ok: gpre.length > 0 && script.length > 0 && inGpre, detail: `gpre=${gpre.length} script_refs=${script.length} listed_in_gpre=${inGpre}`, lines: [...gpre, ...script] };
    },
  },
  {
    id: "V4",
    title: "limited review exit: two-round cap + independent ruling + no reset across versions",
    check() {
      const cap = linesOf(files.plan, (l) => l.includes("两轮上限"));
      const indep = files.plan.includes("Owner 指定的独立会话") || files.plan.includes("Owner 指定的**独立会话**");
      const noreset = linesOf(files.plan, (l) => l.includes("不清零"));
      return { ok: cap.length > 0 && indep && noreset.length > 0, detail: `cap=${cap.length} independent=${indep} no_reset=${noreset.length}`, lines: [...cap, ...noreset] };
    },
  },
  {
    id: "V5",
    title: "refusalTest is no longer a universal obligation",
    check() {
      const schema = linesOf(files.plan, (l) => l.includes("决策队列 | `orchestra/decisions/"));
      const schemaLine = schema.length ? files.plan.split("\n")[schema[0] - 1] : "";
      const demoted = schemaLine.includes("V5") && schemaLine.includes("不是每条决策的普遍义务");
      const universal = /每一条决策记录都带它/.test(schemaLine) && !schemaLine.includes("不再要求");
      return { ok: demoted && !universal, detail: `schema_demotes=${demoted} still_universal=${universal}`, lines: schema };
    },
  },
  {
    id: "V6",
    title: "row-count == case-count dropped as a coverage criterion",
    check() {
      const leftover = linesOf(files.plan, (l) => l.includes("正文表格行数 == 用例条数") && !/V6|不再要求|取消/.test(l));
      const declares = files.plan.includes("V6：只要求用例存在") || files.plan.includes("V6：判据是用例存在性与前缀可解析") || files.plan.includes("V6：判据是用例存在");
      return { ok: leftover.length === 0 && declares, detail: `live_criteria=${leftover.length} declared=${declares}`, lines: leftover };
    },
  },
  {
    id: "V7",
    title: "D4 calls the real handler and validates the actual return value",
    check() {
      const hits = linesOf(files.plan, (l) => l.includes("真实调用它的 handler"));
      const d4 = linesOf(files.plan, (l) => l.includes("| **D4** 工具闭包守卫"));
      const d4Line = d4.length ? files.plan.split("\n")[d4[0] - 1] : "";
      const oldForm = d4Line.includes("形状生成器");
      return { ok: hits.length > 0 && !oldForm, detail: `real_handler=${hits.length} old_form_present=${oldForm}`, lines: [...hits, ...d4] };
    },
  },
  {
    id: "V8",
    title: "four self-document corrections applied",
    check() {
      const a = files.gate2.includes("补丁复验 ≠ 整体执行资格");
      // The withdrawn phrase may only survive INSIDE the correction note that
      // quotes it; a line that uses it as the document's own claim is the defect.
      const explainerLines = files.explainer.split("\n");
      const withdrawnAsClaim = explainerLines.some(
        (l) => l.includes("不消耗任何模型上下文") && !l.includes("原有一句") && !l.includes("已删除"),
      );
      const b = !withdrawnAsClaim && files.explainer.includes("工具调用数不是全部摩擦");
      const c = files.plan.includes("散文亦有版本");
      const d = files.plan.includes("零实现量不构成浪费");
      return { ok: a && b && c && d, detail: `gate2=${a} explainer=${b} prose_version=${c} zero_impl=${d}` };
    },
  },
  {
    id: "V9",
    title: "P2 enablement gate registered (B5 expectedNew counterexample + three more)",
    check() {
      const hits = linesOf(files.plan, (l) => l.includes("B5 的 `expectedNew` 反例"));
      const nonBinary = files.plan.includes("祖先判定非二值");
      const third = files.plan.includes("第三个值 ≠ 合法前进");
      const contradiction = files.plan.includes("控制流自相矛盾");
      return { ok: hits.length > 0 && nonBinary && third && contradiction, detail: `b5=${hits.length} non_binary=${nonBinary} third_value=${third} contradiction=${contradiction}`, lines: hits };
    },
  },
  {
    id: "V10",
    title: "scout minimal spec in plan §0.5 with all six rows",
    check() {
      const sec = linesOf(files.plan, (l) => l.startsWith("### 0.5 scout 最小规范"));
      if (sec.length === 0) return { ok: false, detail: "§0.5 heading not found" };
      const body = files.plan.slice(files.plan.indexOf("### 0.5 scout 最小规范"), files.plan.indexOf("### 0.6"));
      const rows = ["**调用时机**", "**输入**", "**输出**", "**判据**", "**成本上限**", "**产出归属与边界**"]
        .filter((r) => body.includes(r));
      const nativeSub = body.includes('a2a_create(execution:"subagent")');
      const notInP0 = body.includes("不进 P0 代码范围");
      const caps = body.includes("≤ 5 个 scout") && body.includes("不递归") && body.includes("只读");
      return {
        ok: rows.length === 6 && nativeSub && notInP0 && caps,
        detail: `rows=${rows.length}/6 native_subagent=${nativeSub} not_in_p0=${notInP0} caps=${caps}`,
        lines: sec,
      };
    },
  },
];

function main(argv) {
  if (argv.includes("--list")) {
    for (const item of ITEMS) console.log(`${item.id}\t${item.title}`);
    return 0;
  }
  try {
    reload();
  } catch (error) {
    console.error(`check-p0-preconditions: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let failed = 0;
  const okIds = [];
  const badIds = [];
  for (const item of ITEMS) {
    let result;
    try {
      result = item.check();
    } catch (error) {
      result = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
    }
    const where = result.lines !== undefined && result.lines.length > 0 ? `  L${result.lines.slice(0, 4).join(",L")}` : "";
    console.log(`${result.ok ? "V-OK  " : "V-FAIL"}  ${item.id}  ${item.title}`);
    console.log(`          ${result.detail}${where}`);
    if (result.ok) okIds.push(item.id); else { failed += 1; badIds.push(item.id); }
  }
  console.log("");
  console.log(failed === 0
    ? `# V1..V10 ok (${okIds.length}/${ITEMS.length})`
    : `# V1..V10 NOT ok — failed: ${badIds.join(", ")}`);
  console.log("# scope: mechanical presence check only; quality is NOT judged here (ruling §4.4)");
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
export { ITEMS, main };
