import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import fs from "fs";

const SYMBOL = "ETHUSDT";

const BINANCE_USE_PROXY = process.env.BINANCE_USE_PROXY === "1";
const DEEP_USE_PROXY = process.env.DEEP_USE_PROXY === "1";
const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
const BINANCE_AGENT = BINANCE_USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const DEEP_AGENT = DEEP_USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const COMMON_HEADERS = {
    "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
    accept: "application/json"
};

function loadDryRunReport() {
    try {
        const txt = fs.readFileSync(DRY_RUN_REPORT_PATH, "utf-8");
        return JSON.parse(txt);
    } catch (_) {
        return null;
    }
}

function writeDryRunReport(summary) {
    try {
        fs.writeFileSync(DRY_RUN_REPORT_PATH, JSON.stringify(summary, null, 2));
    } catch (_) {
    }
}

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);

const PRICE_DIFF_PCT_THRESHOLD = 0.25;
const FUNDING_DIFF_THRESHOLD = 0.0005;
const INTERVAL = 3000;

const DRY_RUN = process.env.DRY_RUN === "1";
const DRY_RUN_DURATION_MS = Number(process.env.DRY_RUN_DURATION_MS || 24 * 60 * 60 * 1000);
const DRY_RUN_LOG_PATH = process.env.DRY_RUN_LOG_PATH || "./dry_run_log.jsonl";
const DRY_RUN_REPORT_PATH = process.env.DRY_RUN_REPORT_PATH || "./dry_run_report.json";
const LIVE_TRADING = process.env.LIVE_TRADING === "1";

const FUNDING_FILTER_ENABLED = process.env.FUNDING_FILTER_ENABLED === "1";

const LEVERAGE = Number(process.env.LEVERAGE || 50);
const ACCOUNT_USDT_PER_EXCHANGE = Number(process.env.ACCOUNT_USDT_PER_EXCHANGE || 200);
const MAX_MARGIN_PCT = Number(process.env.MAX_MARGIN_PCT || 0.2);
const MAX_ADVERSE_SPREAD_PCT = Number(process.env.MAX_ADVERSE_SPREAD_PCT || 0.3);
const EXIT_SPREAD_PCT = Number(process.env.EXIT_SPREAD_PCT || 0.05);
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MS || 60 * 60 * 1000);

const SIM_MARGIN_USDT = ACCOUNT_USDT_PER_EXCHANGE * MAX_MARGIN_PCT;
const SIM_NOTIONAL_USDT = SIM_MARGIN_USDT * LEVERAGE;

const DRY_RUN_STARTED_AT = Date.now();
let DRY_RUN_LAST_SUMMARY_AT = 0;

const dryRunState = {
    opportunities: 0,
    entriesAttempted: 0,
    entriesBlocked: 0,
    entriesOpened: 0,
    exitsByTakeProfit: 0,
    exitsByTimeout: 0,
    stopByAdverseSpread: 0,
    wouldLiquidate: 0,
    fundingReversal: 0,
    lastFundingDiffSign: null,
    open: null
};

function nowTs() {
    return Date.now();
}

function signedSpreadPct(binance, deep) {
    const mid = (binance.price + deep.price) / 2;
    return (binance.price - deep.price) / mid * 100;
}

function signOf(x) {
    if (!Number.isFinite(x) || x === 0) return 0;
    return x > 0 ? 1 : -1;
}

function isOpportunity(diff) {
    if (diff.priceDiffPct < PRICE_DIFF_PCT_THRESHOLD) return false;
    if (!FUNDING_FILTER_ENABLED) return true;
    return Number.isFinite(diff.fundingDiff) && Math.abs(diff.fundingDiff) >= FUNDING_DIFF_THRESHOLD;
}

function preTradeGate({ binance, deep, diff }) {
    const reasons = [];
    if (!Number.isFinite(binance?.price) || !Number.isFinite(deep?.price)) reasons.push("价格无效");
    if (SIM_MARGIN_USDT > ACCOUNT_USDT_PER_EXCHANGE * MAX_MARGIN_PCT + 1e-9) reasons.push("仓位超过最大比例");
    if (diff.priceDiffPct < PRICE_DIFF_PCT_THRESHOLD) reasons.push("价差不足");
    if (FUNDING_FILTER_ENABLED) {
        if (!Number.isFinite(diff.fundingDiff)) reasons.push("资金费率差不可用");
        else if (Math.abs(diff.fundingDiff) < FUNDING_DIFF_THRESHOLD) reasons.push("资金费率差不足");
    }
    return { ok: reasons.length === 0, reasons };
}

function appendDryRunLog(event) {
    try {
        fs.appendFileSync(DRY_RUN_LOG_PATH, JSON.stringify(event) + "\n");
    } catch (_) {
    }
}

function printDryRunSummary() {
    const runtimeMs = nowTs() - DRY_RUN_STARTED_AT;
    const runtimeH = runtimeMs / (60 * 60 * 1000);
    const summary = {
        generatedAt: new Date().toISOString(),
        runtimeMs,
        config: {
            SYMBOL,
            INTERVAL,
            PRICE_DIFF_PCT_THRESHOLD,
            FUNDING_DIFF_THRESHOLD,
            FUNDING_FILTER_ENABLED,
            LEVERAGE,
            ACCOUNT_USDT_PER_EXCHANGE,
            MAX_MARGIN_PCT,
            MAX_ADVERSE_SPREAD_PCT,
            EXIT_SPREAD_PCT,
            MAX_HOLD_MS
        },
        stats: { ...dryRunState }
    };
    console.log("----------------------------------");
    console.log("[DRY RUN 汇总]");
    console.log("运行时长(h):", runtimeH.toFixed(3));
    console.log("机会次数:", dryRunState.opportunities);
    console.log("尝试进场:", dryRunState.entriesAttempted);
    console.log("被闸门拦截:", dryRunState.entriesBlocked);
    console.log("成功开仓:", dryRunState.entriesOpened);
    console.log("止盈退出:", dryRunState.exitsByTakeProfit);
    console.log("超时退出:", dryRunState.exitsByTimeout);
    console.log("价差反向超容忍(>=", MAX_ADVERSE_SPREAD_PCT, "%):", dryRunState.stopByAdverseSpread);
    console.log("按 50x/保证金估算会爆仓:", dryRunState.wouldLiquidate);
    console.log("资金费率差发生反转:", dryRunState.fundingReversal);
    console.log("日志文件:", DRY_RUN_LOG_PATH);
    console.log("报告文件:", DRY_RUN_REPORT_PATH);
    writeDryRunReport(summary);
}

function maybeStopDryRun() {
    if (!DRY_RUN) return;
    if (nowTs() - DRY_RUN_STARTED_AT < DRY_RUN_DURATION_MS) return;
    printDryRunSummary();
    process.exit(0);
}

process.on("SIGINT", () => {
    if (DRY_RUN) printDryRunSummary();
    process.exit(0);
});

if (LIVE_TRADING) {
    const report = loadDryRunReport();
    const ok = report && Number.isFinite(report.runtimeMs) && report.runtimeMs >= DRY_RUN_DURATION_MS;
    if (!ok) {
        console.error(
            "LIVE_TRADING=1 需要先完成 Dry Run（至少 1 天）。请先运行: DRY_RUN=1 并保持运行满 24h。\n" +
            `期望报告: ${DRY_RUN_REPORT_PATH}`
        );
        process.exit(1);
    }
}

async function getBinance() {
    const [priceRes, fundingRes] = await Promise.all([
        axios.get("https://fapi.binance.com/fapi/v1/ticker/price", {
            params: { symbol: SYMBOL },
            timeout: REQUEST_TIMEOUT_MS,
            headers: COMMON_HEADERS,
            httpsAgent: BINANCE_AGENT
        }),
        axios.get("https://fapi.binance.com/fapi/v1/premiumIndex", {
            params: { symbol: SYMBOL },
            timeout: REQUEST_TIMEOUT_MS,
            headers: COMMON_HEADERS,
            httpsAgent: BINANCE_AGENT
        })
    ]);

    return {
        name: "Binance",
        price: Number(priceRes.data.price),
        funding: Number(fundingRes.data.lastFundingRate)
    };
}

function formatPct(rate) {
    return Number.isFinite(rate) ? `${(rate * 100).toFixed(4)} %` : "N/A";
}

function calcDiff(a, b) {
    const mid = (a.price + b.price) / 2;
    return {
        priceDiffPct: Math.abs(a.price - b.price) / mid * 100,
        fundingDiff:
            Number.isFinite(a.funding) && Number.isFinite(b.funding)
                ? a.funding - b.funding
                : Number.NaN
    };
}

function hedgeDirection(binance, deep) {
    return binance.price > deep.price
        ? "Binance 开空 / Deepcoin 开多"
        : "Deepcoin 开空 / Binance 开多";
}

let MONITOR_IN_FLIGHT = false;

async function monitor() {
    if (MONITOR_IN_FLIGHT) return;
    MONITOR_IN_FLIGHT = true;
    try {
        const [binanceRes, deepRes] = await Promise.allSettled([
            getBinance(),
            getDeep()
        ]);

        if (process.stdout.isTTY) console.clear();
        console.log("========== ETH 对冲监控 ==========");
        console.log(new Date().toLocaleString());

        if (binanceRes.status !== "fulfilled") {
            console.log("----------------------------------");
            console.log(
                "Binance 获取失败:",
                binanceRes.reason?.message || String(binanceRes.reason)
            );
            return;
        }

        const binance = binanceRes.value;
        const deep = deepRes.status === "fulfilled" ? deepRes.value : null;
        console.log("----------------------------------");
        console.log("Binance 价格:", binance.price);
        console.log("Binance 资金费率:", formatPct(binance.funding));

        if (!deep) {
            console.log("Deepcoin 价格:", "N/A");
            console.log("Deepcoin 资金费率:", "N/A");
            console.log("----------------------------------");
            console.log(
                "Deepcoin 获取失败:",
                deepRes.status === "rejected" ? (deepRes.reason?.message || String(deepRes.reason)) : "未知错误"
            );
            return;
        }

        const diff = calcDiff(binance, deep);
        const spreadPct = signedSpreadPct(binance, deep);

        console.log("Deepcoin 价格:", deep.price);
        console.log("Deepcoin 资金费率:", formatPct(deep.funding));
        console.log("----------------------------------");
        console.log("价差:", diff.priceDiffPct.toFixed(3), "%");
        console.log("资金费率差:", formatPct(diff.fundingDiff));
        console.log("建议方向:", hedgeDirection(binance, deep));

        if (DRY_RUN) {
            if (nowTs() - DRY_RUN_LAST_SUMMARY_AT > 5 * 60 * 1000) {
                DRY_RUN_LAST_SUMMARY_AT = nowTs();
                console.log("----------------------------------");
                console.log(
                    "[DRY RUN] runtime(min):",
                    ((nowTs() - DRY_RUN_STARTED_AT) / 60000).toFixed(1),
                    " open:",
                    dryRunState.open ? "YES" : "NO",
                    " fundingFilter:",
                    FUNDING_FILTER_ENABLED ? "ON" : "OFF"
                );
            }
        }

        const fundingDiffSign = Number.isFinite(diff.fundingDiff) ? signOf(diff.fundingDiff) : null;
        if (DRY_RUN && fundingDiffSign !== null) {
            if (dryRunState.lastFundingDiffSign === null) dryRunState.lastFundingDiffSign = fundingDiffSign;
            else if (fundingDiffSign !== 0 && dryRunState.lastFundingDiffSign !== 0 && fundingDiffSign !== dryRunState.lastFundingDiffSign) {
                dryRunState.fundingReversal += 1;
                dryRunState.lastFundingDiffSign = fundingDiffSign;
            }
        }

        const opportunity = isOpportunity(diff);
        if (DRY_RUN && opportunity) dryRunState.opportunities += 1;

        if (DRY_RUN && opportunity && !dryRunState.open) {
            dryRunState.entriesAttempted += 1;
            const gate = preTradeGate({ binance, deep, diff });
            if (!gate.ok) {
                dryRunState.entriesBlocked += 1;
                appendDryRunLog({ ts: nowTs(), type: "blocked", reasons: gate.reasons, binance, deep, diff });
            } else {
                const direction = spreadPct > 0 ? "SHORT_BINANCE_LONG_DEEP" : "SHORT_DEEP_LONG_BINANCE";
                const entry = {
                    openedAt: nowTs(),
                    direction,
                    entryBinance: binance.price,
                    entryDeep: deep.price,
                    entrySpreadPct: spreadPct,
                    maxAdverseMovePct: 0,
                    wouldLiquidate: false,
                    fundingDiffAtEntry: Number.isFinite(diff.fundingDiff) ? diff.fundingDiff : Number.NaN
                };
                dryRunState.open = entry;
                dryRunState.entriesOpened += 1;
                appendDryRunLog({ ts: nowTs(), type: "open", entry, binance, deep, diff });
            }
        }

        if (DRY_RUN && dryRunState.open) {
            const pos = dryRunState.open;
            const adverseMove = pos.entrySpreadPct >= 0
                ? (spreadPct - pos.entrySpreadPct)
                : (pos.entrySpreadPct - spreadPct);
            if (adverseMove > pos.maxAdverseMovePct) pos.maxAdverseMovePct = adverseMove;

            const qty = SIM_NOTIONAL_USDT / ((pos.entryBinance + pos.entryDeep) / 2);
            const longLoss = (entryPrice, currentPrice) => Math.max(0, (entryPrice - currentPrice) * qty);
            const shortLoss = (entryPrice, currentPrice) => Math.max(0, (currentPrice - entryPrice) * qty);

            const binLoss = pos.direction === "SHORT_BINANCE_LONG_DEEP"
                ? shortLoss(pos.entryBinance, binance.price)
                : longLoss(pos.entryBinance, binance.price);
            const deepLoss = pos.direction === "SHORT_BINANCE_LONG_DEEP"
                ? longLoss(pos.entryDeep, deep.price)
                : shortLoss(pos.entryDeep, deep.price);

            const wouldLiq = binLoss >= SIM_MARGIN_USDT || deepLoss >= SIM_MARGIN_USDT;
            if (wouldLiq && !pos.wouldLiquidate) {
                pos.wouldLiquidate = true;
                dryRunState.wouldLiquidate += 1;
                appendDryRunLog({ ts: nowTs(), type: "would_liquidate", pos, binLoss, deepLoss, binance, deep, diff, spreadPct });
            }

            const hitStop = adverseMove >= MAX_ADVERSE_SPREAD_PCT;
            const hitTp = Math.abs(spreadPct) <= EXIT_SPREAD_PCT;
            const hitTimeout = nowTs() - pos.openedAt >= MAX_HOLD_MS;

            if (hitStop || hitTp || hitTimeout) {
                const reason = hitStop ? "stop_adverse_spread" : (hitTp ? "take_profit" : "timeout");
                if (hitStop) dryRunState.stopByAdverseSpread += 1;
                if (hitTp) dryRunState.exitsByTakeProfit += 1;
                if (hitTimeout) dryRunState.exitsByTimeout += 1;
                appendDryRunLog({ ts: nowTs(), type: "close", reason, pos, binance, deep, diff, spreadPct });
                dryRunState.open = null;
            }
        }

        if (
            diff.priceDiffPct >= PRICE_DIFF_PCT_THRESHOLD &&
            Number.isFinite(diff.fundingDiff) &&
            Math.abs(diff.fundingDiff) >= FUNDING_DIFF_THRESHOLD
        ) {
            console.log(" 对冲机会出现（50x 高风险）");
        } else {
            console.log(" 暂无安全对冲机会");
        }
    } catch (err) {
        console.error("监控错误:", err?.message || err);
    } finally {
        MONITOR_IN_FLIGHT = false;
        maybeStopDryRun();
    }
}

async function getDeep() {
    const instType = process.env.DEEP_INST_TYPE || "SWAP";
    const envInstId = process.env.DEEP_INST_ID;
    const instIdCandidates = [
        envInstId,
        "ETH-USDT-SWAP",
        "2ETH-USDT-SWAP",
        "3ETH-USDT-SWAP",
        "ETH-USD-SWAP",
        "1ETH-USD-SWAP"
    ].filter(Boolean);

    const res = await axios.get("https://api.deepcoin.com/deepcoin/market/tickers", {
        params: { instType },
        timeout: REQUEST_TIMEOUT_MS,
        headers: COMMON_HEADERS,
        httpsAgent: DEEP_AGENT
    });

    const list = res.data?.data;
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error("Deepcoin 行情接口返回为空");
    }

    const item =
        list.find(i => instIdCandidates.includes(i?.instId)) ||
        list.find(i => (i?.instId || "").includes("ETH") && (i?.instId || "").includes("SWAP")) ||
        list[0];

    const price = Number(item?.last);
    const funding =
        item?.fundingRate ??
        item?.funding_rate ??
        item?.funding;

    if (!Number.isFinite(price)) {
        throw new Error("Deepcoin 行情解析失败（price 非数字）");
    }

    return {
        name: "Deepcoin",
        price,
        funding: funding === undefined ? Number.NaN : Number(funding)
    };
}

console.log("启动 Binance ↔ Deepcoin ETH 对冲监控...");
monitor();
setInterval(monitor, INTERVAL);