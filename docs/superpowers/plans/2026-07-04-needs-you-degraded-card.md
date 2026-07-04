# Needs-You Degraded Card (#189) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a right-rail "Needs you" card that lists open issues awaiting a human decision (labelled `needs-design`/`needs-spec`), clearly marked *untriaged* — the spec-sanctioned degraded state of UI-6 until the PM rail (#89) emits structured triaged questions.

**Architecture:** A pure, total parser `parse_needs_you(raw_json)` lives in the tested `dashboard_state.py` layer (TDD-able seam). The gh fetch (`gh issue list --search "label:needs-design,needs-spec state:open"`) is added to `dashboard.py`'s single-flight in-flight refresh block alongside the existing PR/merge fetches (best-effort, cached, degrade-to-empty). The page renders a new `renderNeedsYou` panel in `zone-tele`, aggregating across repos, mirroring the existing `renderHandoffs` pattern.

**Tech Stack:** Python 3 stdlib only; vanilla JS/HTML dashboard; `gh` CLI.

## Global Constraints

- macOS `/bin/bash` 3.2.57 floor — N/A here (Python + JS only).
- Python 3 stdlib only — no new imports.
- Repo-agnostic (`bin/`/`lib/`): the label set is a module-level constant of **generic engineering-workflow labels** (`needs-design`, `needs-spec`) — no GitHub owner / board title / issue number hardcoded. The gh call is repo-cwd-scoped, no owner interpolation.
- Fail-safe / best-effort: a gh failure, missing field, or malformed JSON yields an empty list — never a fabricated entry, never a page blank, never a raised request (settled-decisions 4/6; prevention-log 12: the parser is total, runs safe on any input).
- Labels are the routing contract; display-only, never gates anything (settled-decision 23).
- Honesty: the card is explicitly marked *untriaged — pending PM triage (#89)*; the full triaged question contract is out of scope (blocked on #89).

---

### Task 1: `parse_needs_you` pure parser + tests

**Files:**
- Modify: `lib/dashboard_state.py` (add module-level `NEEDS_YOU_LABELS` + `parse_needs_you`)
- Test: `tests/test_dashboard_state.py` (new test class)

**Interfaces:**
- Produces: `parse_needs_you(raw)` — `raw` is the string stdout of `gh issue list --json number,title,url,labels,updatedAt` (or `None`/`""`). Returns `list[dict]`, each `{"number": int, "title": str, "url": str, "labels": [str,...], "updated_at": str}`, sorted by `updated_at` descending (most-recent first). **An entry is KEPT only if it has an int `number` AND at least one label in `NEEDS_YOU_LABELS`** — this is the fail-safe filter (Codex CP1): a broadened/mocked query can never surface an unrelated issue as "needs you". Any parse failure / non-list / malformed-shape input → `[]` or that entry skipped. Total: never raises on any input.
- Also exposes `NEEDS_YOU_LABELS = ("needs-design", "needs-spec")`.

- [ ] **Step 1: Write the failing tests**

```python
class TestParseNeedsYou(unittest.TestCase):
    def test_parses_and_sorts_desc_by_updated(self):
        raw = json.dumps([
            {"number": 1, "title": "old", "url": "u1", "labels": [{"name": "needs-design"}], "updatedAt": "2026-07-01T00:00:00Z"},
            {"number": 2, "title": "new", "url": "u2", "labels": [{"name": "needs-spec"}], "updatedAt": "2026-07-03T00:00:00Z"},
        ])
        out = ds.parse_needs_you(raw)
        self.assertEqual([i["number"] for i in out], [2, 1])
        self.assertEqual(out[0]["labels"], ["needs-spec"])
        self.assertEqual(out[0]["updated_at"], "2026-07-03T00:00:00Z")

    def test_none_and_empty_and_garbage_yield_empty(self):
        for raw in (None, "", "not json", "{}", "[42]"):
            self.assertEqual(ds.parse_needs_you(raw), [])

    def test_entry_without_matching_label_is_dropped(self):
        # fail-safe filter: only NEEDS_YOU_LABELS issues are "needs you",
        # even if the query somehow returns others.
        raw = json.dumps([{"number": 5, "title": "t", "url": "u",
                           "labels": [{"name": "bug"}], "updatedAt": "z"}])
        self.assertEqual(ds.parse_needs_you(raw), [])

    def test_entry_without_int_number_is_dropped(self):
        raw = json.dumps([{"number": None, "title": "t", "url": "u",
                           "labels": [{"name": "needs-design"}], "updatedAt": "z"},
                          {"title": "t2", "url": "u2",
                           "labels": [{"name": "needs-design"}], "updatedAt": "z"}])
        self.assertEqual(ds.parse_needs_you(raw), [])

    def test_malformed_shapes_do_not_crash(self):
        # labels non-iterable, updatedAt/number wrong types, entry not a dict
        raw = json.dumps([
            {"number": 7, "title": "t", "url": "u", "labels": 1, "updatedAt": "z"},
            {"number": 8, "title": "t", "url": "u", "labels": [{"name": "needs-spec"}], "updatedAt": 1},
            {"number": {}, "labels": [{"name": "needs-design"}], "updatedAt": "z"},
            42,
        ])
        out = ds.parse_needs_you(raw)
        # #7 kept (labels:1 -> no match -> dropped)? no: 1 non-iterable -> [] labels -> dropped.
        # #8 kept: has int number + needs-spec label; updated_at coerced to "".
        self.assertEqual([i["number"] for i in out], [8])
        self.assertEqual(out[0]["updated_at"], "")

    def test_labels_normalised_to_names(self):
        raw = json.dumps([{"number": 7, "title": "t", "url": "u", "labels": [{"name": "needs-design"}, {"color": "x"}], "updatedAt": ""}])
        self.assertEqual(ds.parse_needs_you(raw)[0]["labels"], ["needs-design"])
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 tests/test_dashboard_state.py TestParseNeedsYou -v`
Expected: FAIL — `AttributeError: module 'dashboard_state' has no attribute 'parse_needs_you'`

- [ ] **Step 3: Implement (total, stdlib-only)**

Add near the other pure projections in `lib/dashboard_state.py`:

```python
NEEDS_YOU_LABELS = ("needs-design", "needs-spec")


def parse_needs_you(raw):
    """Parse `gh issue list --json number,title,url,labels,updatedAt` output
    into the untriaged needs-you list, newest first. Total: any bad input
    (None / non-JSON / non-list / malformed shape) degrades to [] or a skipped
    entry -- never raises, never fabricates. An entry is kept ONLY if it has an
    int number AND at least one NEEDS_YOU_LABELS label, so a broadened/mocked
    query can never surface an unrelated issue (fail-safe filter, Codex CP1).
    Display-only (settled-decision 23); fail-safe (4/6)."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    wanted = set(NEEDS_YOU_LABELS)
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        num = it.get("number")
        if not isinstance(num, int) or isinstance(num, bool):
            continue
        raw_labels = it.get("labels")
        labels = []
        if isinstance(raw_labels, list):
            for lb in raw_labels:
                if isinstance(lb, dict) and isinstance(lb.get("name"), str):
                    labels.append(lb["name"])
        if not wanted.intersection(labels):
            continue
        title = it.get("title")
        url = it.get("url")
        at = it.get("updatedAt")
        out.append({
            "number": num,
            "title": title if isinstance(title, str) else "",
            "url": url if isinstance(url, str) else "",
            "labels": labels,
            "updated_at": at if isinstance(at, str) else "",
        })
    out.sort(key=lambda i: i["updated_at"], reverse=True)
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `python3 tests/test_dashboard_state.py TestParseNeedsYou -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard_state.py tests/test_dashboard_state.py
git commit -m "feat: parse_needs_you pure parser for the untriaged needs-you list (#189)"
```

---

### Task 2: gh fetch wiring + right-rail render + browser verify

**Files:**
- Modify: `bin/dashboard.py` (in-flight refresh block ~L585-676: add `_needs_you_raw`, thread it, attach `needs_you` to `result`; `_empty_in_flight` gains `"needs_you": []`)
- Modify: `lib/dashboard_page.html` (new panel in `zone-tele`; `renderNeedsYou`; call it from `render`)

**Interfaces:**
- Consumes: `ds.parse_needs_you` (Task 1); the per-repo card's `git` block (where PRs/merged already live).
- Produces: each repo card's `git.needs_you` = `list` from `parse_needs_you`; page reads `r.git.needs_you`.

- [ ] **Step 1: Add `needs_you` to `_empty_in_flight`**

In `bin/dashboard.py` `_empty_in_flight()` return dict, add `"needs_you": [],` (keeps the never-blank fallback well-formed).

- [ ] **Step 2: Add the fetch in the in-flight refresh block**

Beside `_open_raw`/`_merged_raw` (~L590):

```python
    def _needs_you_raw():
        # Untriaged human-decision queue (#189 degraded state). Labels are a
        # fixed generic-workflow constant (repo-agnostic); cwd-scoped, no owner
        # interpolation. sort:updated-desc lives IN the search so the --limit
        # keeps the newest 20 (Codex CP1). Best-effort: "" on any gh failure.
        return _run(["gh", "issue", "list", "--limit", "20",
                     "--search", "state:open label:%s sort:updated-desc"
                                 % ",".join(ds.NEEDS_YOU_LABELS),
                     "--json", "number,title,url,labels,updatedAt"],
                    cwd=repo, timeout=20)
```

Add it to the `ThreadPoolExecutor` (bump `max_workers` 3→4), submit `f_needs = pool.submit(_needs_you_raw)`, read `nyraw = f_needs.result()`.

- [ ] **Step 3: Attach to result**

In the `result = {...}` dict add `"needs_you": ds.parse_needs_you(nyraw),`.

- [ ] **Step 4: Add the panel HTML** in `zone-tele` (after Handoffs panel, before Supervisor voice):

```html
      <div class="sh"><h2>Needs you</h2><span class="ln"></span><span class="ct">untriaged · pending PM triage (#89)</span></div>
      <div class="panel"><div class="p-h" style="border-bottom:1px solid var(--hair)"><span class="sub">open issues awaiting a human decision — needs-design / needs-spec</span></div><div class="hfeed" id="needsyou"></div></div>
```

- [ ] **Step 5: Add `renderNeedsYou`** (mirrors `renderHandoffs`), and call it from `render(s)`:

```javascript
function renderNeedsYou(repos){
  const rows=[];repos.forEach(r=>((r.git&&r.git.needs_you)||[]).forEach(i=>rows.push({repo:r.name,i})));
  const many=repos.filter(r=>r.git&&(r.git.needs_you||[]).length).length>1;
  if(!rows.length){$("needsyou").innerHTML=`<div class="empty">Nothing awaiting a decision — needs-design/needs-spec issues appear here.</div>`;return;}
  $("needsyou").innerHTML=rows.map(x=>{const i=x.i;
    const labs=(i.labels||[]).map(l=>`<span class="chip">${esc(l)}</span>`).join("");
    const num=i.number!=null?("#"+esc(i.number)):"";
    const link=i.url?`<a href="${esc(i.url)}" target="_blank" rel="noopener">${num}</a>`:num;
    return `<div class="hln">${labs}<span class="hact">${many?"["+esc(x.repo)+"] ":""}${link} ${esc(i.title)}</span></div>`;}).join("");
}
```

Add `renderNeedsYou(s.repos);` to the `render(s)` body (after `renderHandoffs(s.repos);`).

- [ ] **Step 6: Guard the new render mount in the shell contract test**

In `tests/test_dashboard_server.py`, add `b'id="needsyou"',` to `TestControlRoomShell.MOUNTS` (next to `b'id="handoffs"'`) so a future reskin can't silently drop the panel.

- [ ] **Step 7: Run existing suites — no regression**

Run: `python3 tests/test_dashboard_state.py -v && python3 tests/test_dashboard_server.py -v`
Expected: PASS (server test still serves a well-formed page/state; MOUNTS includes `needsyou`).

- [ ] **Step 8: Browser verify — degraded/empty state on the fixture**

```bash
python3 bin/dashboard.py --repo tests/fixtures/repo-alpha --port 8790 &
```
Drive `/` via chrome-devtools MCP: `new_page` → `take_snapshot` → `list_console_messages` (ZERO errors) → `list_network_requests` (`/api/state` 200). Assert the "Needs you" panel renders its empty state ("Nothing awaiting a decision …") since the fixture has no gh remote.

- [ ] **Step 9: Browser verify — populated state via deterministic JS injection**

Codex CP1: don't depend on live GitHub issues (brittle, repo-specific). On the same repo-alpha page, use `evaluate_script` to call the render path with fabricated data:

```js
renderNeedsYou([{name:"repo-alpha", git:{needs_you:[
  {number:189, title:"UI-6: needs-you", url:"https://x/189", labels:["needs-design"], updated_at:"2026-07-04T00:00:00Z"},
  {number:89, title:"W5: role rails", url:"https://x/89", labels:["needs-spec"], updated_at:"2026-07-03T00:00:00Z"}]}}]);
document.getElementById("needsyou").innerText
```

Assert the returned text contains `#189`, `#89`, and both label chips; `take_snapshot` shows the links. Then kill the server.

- [ ] **Step 10: Commit**

```bash
git add bin/dashboard.py lib/dashboard_page.html
git commit -m "feat: needs-you untriaged card in the telemetry rail (#189 degraded state)"
```

---

## Self-Review

- **Spec coverage:** Issue #189 degraded state ("raw needs-design list, clearly marked untriaged") → Tasks 1+2. Full triaged question contract (recommendation/effort/default-if-ignored/answer chips) → OUT OF SCOPE, blocked on #89 (stated in issue + PR). Right-rail home → spec §51.
- **Placeholder scan:** none — all steps carry real code.
- **Type consistency:** `parse_needs_you` return shape (`number/title/url/labels/updated_at`) is consumed verbatim by `renderNeedsYou` (`i.number/i.title/i.url/i.labels`); `NEEDS_YOU_LABELS` defined Task 1, consumed Task 2.
