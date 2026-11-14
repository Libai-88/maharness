"""Summarize completed evaluation evidence without replaying model or tool calls."""
import hashlib
import io
import json
import re
import statistics
import subprocess
import tarfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REPORTS = HERE.parent
NAMES = ["composition-final3-20261115", "release-composition-final3-20261115"]
archive = subprocess.check_output(["git", "archive", "1f11902", "web-agent/core", "web-agent/kernel", "web-agent/server", "web-agent/evals", "web-agent/scripts", "web-agent/ui/src"], cwd=ROOT.parent)
with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
    committed_sources = {entry.name.removeprefix("web-agent/"): tree.extractfile(entry).read()
                         for entry in tree if entry.isfile()}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def success(row):
    return bool(row["completed"] and not row.get("runtimeError", row.get("error"))
                and row["assertions"] and all(check["passed"] for check in row["assertions"]))


def identity(row):
    if "key" in row:
        return tuple(json.loads(row["key"]))
    return row.get("tier", row.get("model")), row["caseId"], row["variant"], row["repetition"]


def budget(path):
    last = {row["id"]: row for row in rows(path)}
    return {"file": str(path.relative_to(ROOT)).replace("\\", "/"), "sha256": sha(path),
            "requests": len(last), "accounted": sum(row["accounted"] for row in last.values()),
            "states": dict(Counter(row["state"] for row in last.values())),
            "unsettledReservationTokens": sum(row["accounted"] for row in last.values() if row["state"] == "reserved")}


def composition_sequence(folder, row):
    filename = f"{row['variant']}-{row['model'].replace('/', '_')}-{row['caseId']}-{row['repetition']}.json"
    path = folder / filename
    if not path.exists():
        return {"executionEvidence": False}
    evidence = read(path)
    events = evidence["events"]
    succeeded = {event["data"]["id"] for event in events if event["type"] == "tool_result" and event["data"].get("ok") is True}
    starts = [event for event in events if event["type"] == "tool_start" and event["data"]["id"] in succeeded]
    case = row["caseId"]
    checks = {}
    if case in {"command", "dependency", "provider"}:
        kind, name = {"command": ("command", "upper"), "dependency": ("command", "multiply"),
                      "provider": ("provider", "local-response")}[case]
        checks["hostEntryInvoked"] = any(event["data"]["name"] == "invoke_plugin"
                                         and event["data"].get("args", {}).get("kind") == kind
                                         and event["data"].get("args", {}).get("name") == name for event in starts)
    if case == "failed-upgrade":
        active = [event["seq"] for event in events if event["type"] == "plugin_activated" and event["data"].get("id") == "stable-plugin"]
        failed = [event["seq"] for event in events if event["type"] == "plugin_error" and event["data"].get("id") == "stable-plugin"]
        values = [event["seq"] for event in starts if event["data"]["name"] == "stable_value"]
        checks["workingVersionCalledAfterFailedUpgrade"] = any(a < b < c for a in active for b in failed for c in values)
    if case == "release-resources":
        values = [event["seq"] for event in starts if event["data"]["name"] == "lifetime_value"]
        disables = [event["seq"] for event in starts if event["data"]["name"] == "disable_plugin"
                    and event["data"].get("args", {}).get("id") == "temporary"]
        releases = [event["seq"] for event in events if event["type"] == "plugin_released" and event["data"].get("id") == "temporary"]
        statuses = [event["seq"] for event in starts if event["data"]["name"] == "plugin_status"]
        checks["explicitReleaseThenStatusRead"] = any(a < b < c < d for a in values for b in disables for c in releases for d in statuses)
    return checks


def write_composition_report(folder):
    manifest = read(folder / "manifest.json")
    report = read(folder / "report.json")
    samples = rows(folder / "samples.jsonl")
    if len(samples) != 144 or not report["sourceRevisionCurrent"]:
        raise RuntimeError("Composition report requires the complete evaluated revision")
    passed = [row for row in samples if success(row)]
    verified = [row for row in passed if all(composition_sequence(folder, row).values())]
    lines = ["# maharness 插件组合真实评测", "", "日期：2026-11-15。完整矩阵：144/144。评测版本：`1f11902`。基线版本：`058c363`。归档源码指纹对应评测版本；最终代码的角色委派超时补丁另有确定性与混合真实回归证据，本矩阵不代表补丁后的完整性能复测。", "",
             "| 路由 | 组别 | 通过 / 样本 | 成功率 | usage 完整样本 |",
             "| --- | --- | --- | --- | --- |"]
    for model in report["models"]:
        for variant in model["variants"]:
            lines.append(f"| {model['model']} | {variant['variant']} | {variant['passed']} / {variant['samples']} | {variant['passed'] / variant['samples']:.1%} | {variant['completeUsage']} / {variant['samples']} |")
    columns = [(model, variant) for model in manifest["models"] for variant in ["baseline", "v2"]]
    lines += ["", "## 任务结果", "", "| 任务 | " + " | ".join(f"{model} {variant}" for model, variant in columns) + " |",
              "| --- | " + " | ".join("---" for _ in columns) + " |"]
    for case in manifest["cases"]:
        scores = []
        for model, variant in columns:
            group = [row for row in samples if row["caseId"] == case["id"] and row["model"] == model and row["variant"] == variant]
            scores.append(f"{sum(success(row) for row in group)} / {len(group)}")
        lines.append(f"| {case['id']} | " + " | ".join(scores) + " |")
    receipts = [receipt for row in samples for receipt in row["receipts"]]
    http_errors = sum(receipt.get("status", 0) >= 400 for receipt in receipts)
    missing_usage = sum(receipt.get("input") is None or receipt.get("output") is None for receipt in receipts)
    runtime_errors = sum(bool(row.get("error")) for row in samples)
    lines += ["", "## 执行证据", "",
              f"原始断言通过 {len(passed)} 个样本；执行顺序复核通过 {len(verified)} 个。命令、Provider、依赖调用核对成功工具回执；失败升级核对旧版本激活、候选失败和随后成功调用的先后关系；资源释放核对显式停用、释放事件与随后状态读取。复核不重放模型或工具调用。", "",
              f"请求数：{len(receipts)}；HTTP 错误回执：{http_errors}；缺少完整 usage 的请求：{missing_usage}；含运行错误的样本：{runtime_errors}。这些观察可重叠，不作为互斥的失败归因。", "",
              f"保守 token 计账：{report['tokensAccounted']:,}。usage 缺失或响应不确定的请求保留预留量；已回传用量与保守计账不混为同一指标。", "",
              "## 证据边界", "",
              "成功要求任务执行结束且所有原始断言通过。基线缺少新的任务插件契约；本矩阵比较自扩展入口的实际功能，不能解释为相同工具能力下的纯循环性能差异。persona 未单独进入真实专项，其注册与释放由确定性测试覆盖。", "",
              "路由名称不证明固定底层模型版本；免费账单不能验证非零费用的百分比增幅。专项结果不能单独批准发布。", "",
              "原始样本见 [samples.jsonl](samples.jsonl)，失败断言见 [report.json](report.json)，执行参数见 [manifest.json](manifest.json)，源码指纹见 [evaluated-sources.json](evaluated-sources.json)，完整预算与配对审计见 [final-audit.json](../composition-validation-20261115/final-audit.json)。", ""]
    (folder / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")


sources = {}
for directory in ["core", "kernel", "server", "evals", "scripts", "ui/src"]:
    for path in (ROOT / directory).rglob("*"):
        relative = path.relative_to(ROOT)
        if any(part in {"reports", "node_modules"} or re.search(r"@[0-9a-f]{10}$", part) for part in relative.parts):
            continue
        if path.is_file() and path.suffix in {".ts", ".tsx", ".mjs"}:
            sources[relative.as_posix()] = sha(path)

batches = {}
raw = {}
for name, count in zip(NAMES, [144, 540]):
    folder = REPORTS / name
    original = rows(folder / "samples.jsonl")
    if len(original) != count or len({identity(row) for row in original}) != count:
        raise RuntimeError(f"Incomplete or duplicated matrix: {name}")
    expected_sources = read(folder / "evaluated-sources.json")
    for path, expected_hash in expected_sources.items():
        committed = committed_sources[path]
        current_bytes = (ROOT / path).read_bytes()
        unchanged = hashlib.sha256(current_bytes).hexdigest() == expected_hash
        normalized_match = unchanged and current_bytes.replace(b"\r\n", b"\n") == committed.replace(b"\r\n", b"\n")
        if not normalized_match and expected_hash not in {hashlib.sha256(committed).hexdigest(), hashlib.sha256(committed.replace(b"\r\n", b"\n")).hexdigest(), hashlib.sha256(committed.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")).hexdigest()}:
            raise RuntimeError(f"Archived fingerprint does not match evaluated commit: {path}")
    differences = [{"path": path, "evaluated": expected_sources.get(path), "current": sources.get(path)}
                   for path in sorted(set(expected_sources) | set(sources)) if expected_sources.get(path) != sources.get(path)]
    allowed = {"core/self-extend/runtime.ts", "core/self-extend/tests/task-plugins.spec.ts"}
    if any(item["path"] not in allowed for item in differences):
        raise RuntimeError("Unexpected runtime changes after the evaluated commit")
    manifest = read(folder / "manifest.json")
    model_ids = [model if isinstance(model, str) else model["tier"] for model in manifest["models"]]
    variants = manifest.get("variants", ["baseline", "reference", "v2"])
    matrix = {(model, case["id"], variant, repetition) for model in model_ids
              for case in manifest["cases"] for variant in variants for repetition in [1, 2, 3]}
    if {identity(row) for row in original} != matrix:
        raise RuntimeError("Unexpected matrix sample identities")
    selected = rows(folder / manifest.get("sampleFile", "samples.jsonl"))
    if {identity(row) for row in selected} != {identity(row) for row in original}:
        raise RuntimeError("Scored sample identities differ")
    started = rows(folder / "started.jsonl")
    if {identity(row) for row in started} != {identity(row) for row in original} or len(started) != count:
        raise RuntimeError("Started sample ledger differs")
    summaries = []
    sequences = [{"key": list(identity(row)), "checks": composition_sequence(folder, row)} for row in selected] if count == 144 else []
    sequence_by_key = {tuple(item["key"]): item["checks"] for item in sequences}
    for model in sorted({row.get("tier", row.get("model")) for row in selected}):
        for variant in sorted({row["variant"] for row in selected}):
            group = [row for row in selected if row.get("tier", row.get("model")) == model and row["variant"] == variant]
            failed = [row for row in group if not success(row)]
            receipts = [call for row in group for call in row.get("providerCalls", row.get("receipts", []))]
            summaries.append({"model": model, "variant": variant, "samples": len(group),
                              "passed": sum(success(row) for row in group),
                              **({"sequenceVerifiedPassed": sum(success(row) and all(sequence_by_key[identity(row)].values()) for row in group)} if sequences else {}),
                              "successRate": sum(success(row) for row in group) / len(group),
                              "usageCompleteSamples": sum(row.get("usageComplete") is True for row in group),
                              "calls": sum(row["calls"] for row in group),
                              "reportedInputTokens": sum(row["tokensIn"] for row in group),
                              "reportedOutputTokens": sum(row["tokensOut"] for row in group),
                              "httpErrorCalls": sum(call.get("status", 0) >= 400 for call in receipts),
                              "missingUsageCalls": sum(call.get("input") is None or call.get("output") is None for call in receipts),
                              "budgetInterruptedSamples": sum("EVAL_TOKEN_LIMIT" in str(row.get("runtimeError", row.get("error")) or "") for row in failed),
                              "failedSamplesWithRuntimeError": sum(bool(row.get("runtimeError", row.get("error"))) for row in failed)})
    batches[name] = {"samples": count, "samplesSha256": sha(folder / "samples.jsonl"),
                     "scoredFile": manifest.get("sampleFile", "samples.jsonl"),
                     "sourceRevisionCurrent": not differences, "evaluatedCommitVerified": True,
                     "currentSourceDifferences": differences, "sourceFiles": len(expected_sources), "summaries": summaries,
                     **({"sequenceEvidence": sequences} if sequences else {})}
    raw[name] = selected

release = raw[NAMES[1]]
paired = []
for tier in sorted({row["tier"] for row in release}):
    by_key = {(row["caseId"], row["repetition"], row["variant"]): row for row in release if row["tier"] == tier}
    pairs = []
    for (case_id, repetition, variant), baseline in by_key.items():
        if variant != "baseline":
            continue
        current = by_key[(case_id, repetition, "v2")]
        if success(baseline) and success(current) and baseline.get("usageComplete") and current.get("usageComplete"):
            pairs.append({"caseId": case_id, "repetition": repetition, "baselineInput": baseline["tokensIn"], "v2Input": current["tokensIn"],
                          "baselineCalls": baseline["calls"], "v2Calls": current["calls"]})
    before = statistics.median(pair["baselineInput"] for pair in pairs) if pairs else None
    after = statistics.median(pair["v2Input"] for pair in pairs) if pairs else None
    ratio = after / before if before else None
    paired.append({"tier": tier, "pairs": len(pairs), "baselineMedianInput": before, "v2MedianInput": after,
                   "baselineMedianCalls": statistics.median(pair["baselineCalls"] for pair in pairs) if pairs else None,
                   "v2MedianCalls": statistics.median(pair["v2Calls"] for pair in pairs) if pairs else None,
                   "medianInputRatio": ratio, "observedReductionTarget": ratio <= .8 if ratio is not None else None,
                   "fixedModelReductionConfirmed": False,
                   "identityLimitation": "Gateway routes are not pinned model versions; descriptive pairs do not establish a fixed-model effect",
                   "members": sorted(pairs, key=lambda pair: (pair["caseId"], pair["repetition"]))})

budgets = [budget(REPORTS / name / "budget.jsonl") for name in NAMES]
budgets += [budget(path) for path in sorted((HERE / "prior-budget").glob("*/budget.jsonl"))]
role_folder = REPORTS / "composition-role-regression-20261115"
if (role_folder / "budget.jsonl").exists():
    role_budget = budget(role_folder / "budget.jsonl")
    if role_budget["unsettledReservationTokens"]:
        raise RuntimeError("Role regression still has unsettled requests")
    budgets.append(role_budget)
total = sum(item["accounted"] for item in budgets)
if total > 20_000_000:
    raise RuntimeError("Total evaluation token limit exceeded")
for name in NAMES:
    if budget(REPORTS / name / "budget.jsonl")["unsettledReservationTokens"]:
        raise RuntimeError("Final batch still has unsettled requests")

result = {"kind": "composition-evaluation-audit", "implementationRevision": "1f11902",
          "finalRuntimeRevision": "1d9473cf5a15e40e7b55bd7fc6de4557c9db2f83",
          "baselineRevision": "058c3631c51b9f437dfb6dc74d22348a6fcbeedd",
          "sourceRevisionCurrent": all(batch["sourceRevisionCurrent"] for batch in batches.values()),
          "evaluatedCommitVerified": True,
          "commitVerification": "Archived byte fingerprints verified against committed sources with Git line-ending normalization",
          "batches": batches, "pairedInputEfficiency": paired,
          "budget": {"limit": 20_000_000, "accounted": total, "withinLimit": True, "ledgers": budgets},
          "readyForRelease": False,
          "limits": ["v2 observed success rate is below the old baseline on both routes",
                     "Observed paired median input did not meet the 20% reduction target",
                     "Full performance matrices apply to 1f11902, not the final role-timeout patch",
                     "Gateway model versions are unpinned", "Zero-price routes cannot measure a 15% cost ratio",
                     "Optional full Chromium download test cannot acquire a Windows profile lock"]}
if (role_folder / "report.json").exists():
    role_report = read(role_folder / "report.json")
    role_rows = rows(role_folder / "samples.jsonl")
    role_sources = read(role_folder / "evaluated-sources.json")
    if role_sources != sources or len(role_rows) != 6 or len({(row["model"], row["repetition"]) for row in role_rows}) != 6:
        raise RuntimeError("Role regression revision or matrix differs")
    result["roleRegression"] = {**role_report, "sourceRevisionCurrent": True,
                               "deadlineAssertionsPassed": sum(next(check["passed"] for check in row["assertions"] if check["name"] == "delegation outlasted ordinary tool deadline") for row in role_rows)}
    role_lines = ["# 角色委派超时回归", "", "日期：2026-11-15。运行源码：`1d9473c`。类型：确定性父代理与真实子模型的混合回归。", "",
                  f"完整断言通过 {role_report['passed']}/6；角色调用跨过普通工具期限并成功返回 {result['roleRegression']['deadlineAssertionsPassed']}/6。源码指纹对应当前运行源码。", "",
                  "父代理固定调用创建、启用和角色入口，不向网关发送请求；子代理使用配置的真实路由。每个子代理首次请求前等待 35 秒，普通工具期限 30 秒，角色入口期限 240 秒，执行槽位为 1。每样本最多 4 次物理请求，单次输出最多 512 token。", "",
                  "| 路由 | 重复 | 调用耗时（毫秒） | 子任务状态 | 子任务答案 | 完整断言 |", "| --- | --- | --- | --- | --- | --- |"]
    for row in sorted(role_rows, key=lambda row: (row["model"], row["repetition"])):
        child = row["children"][0] if row.get("children") else {}
        answer = child.get("answer") or "（空）"
        role_lines.append(f"| {row['model']} | {row['repetition']} | {row.get('invocationElapsedMs')} | {child.get('status')} | {answer} | {'通过' if row['passed'] else '未通过'} |")
    role_lines += ["", f"共 {sum(len(row['receipts']) for row in role_rows)} 次真实网关请求；保守计账 {role_report['tokensAccounted']:,} token。失败样本原样保留，没有重跑替换。", "",
                   "超时与单槽位调度断言全部通过；一个子模型返回空答案，使完整结果断言未通过。该回归不衡量模型自主设计插件的能力，不能替代完整专项或性能门禁。", "",
                   "运行参数与版本见 [manifest.json](manifest.json)，原始断言见 [samples.jsonl](samples.jsonl)，汇总见 [report.json](report.json)，复现脚本见 [role-live.ts](role-live.ts)。", ""]
    (role_folder / "REPORT.md").write_text("\n".join(role_lines), encoding="utf-8")
(HERE / "final-audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
write_composition_report(REPORTS / NAMES[0])
print(json.dumps({"sourceRevisionCurrent": result["sourceRevisionCurrent"], "accounted": total, "paired": [{key: value for key, value in row.items() if key != "members"} for row in paired]}, ensure_ascii=False))
