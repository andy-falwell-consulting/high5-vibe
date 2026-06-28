# Belay — post-deploy acceptance smoke

Executed by a Claude cloud agent after every production deploy (and on demand)
— see `.github/workflows/acceptance.yml`. The agent gets the deployed `BASE_URL`
and may use `curl`, `python3`, and `Read`.

**Keep it fast: one request per check, no sleeping/polling.** The deploy is
already live by the time this runs. Run every check, then print a **PASS/FAIL
summary** and append it to `$GITHUB_STEP_SUMMARY` (open the file path in that env
var with python3 and write the table).

Treat the run as **FAIL** if any ❗ critical check fails. ⚠️ checks are reported
but don't fail the run.

The app is OAuth-gated, so these are headless/API-level checks of the critical
data path. (Logged-in UI flows would need a stored test session + a browser tool
in CI — a later enhancement.)

---

## 1. Deployment is live ❗
- `GET {BASE_URL}/` → HTTP **200**, body contains `<div id="root">` and an
  `/assets/…` script tag. Response < 3s.

## 2. Auth gate intact ❗
- `GET {BASE_URL}/api/me` → HTTP **401**. A 200 means the gate is broken → FAIL.

## 3. Replica health (one page each) ❗
For each layout, `GET {BASE_URL}/api/records?layout=<key>&db=High5_Core4&cursor=0`
and parse JSON (this returns the first page plus `meta` — do NOT page further):
- HTTP **200**, `records` non-empty, `meta.count > 0`.
- `meta.phase == "idle"` (a stuck `backfill` is ⚠️, note it).
- `meta.count` within ~10% of `meta.total`.
- `meta.lastSync` within the last 24h (stale = ⚠️).

Layouts (key → approx count):
- `contacts` (~15,500) ❗
- `estimates` (~2,800) ❗
- `inspections` (~4,900) ❗
- `trainings` (~2,400) ❗
- `projects` (~6,400) ❗  ← Course Projects (RCD_New)
- `rmi` (~110) ⚠️
- `products` (~1,260) ⚠️
- `oelookup` (~1,200) ⚠️

## 4. Report
- Print a table: check · status (PASS/FAIL/WARN) · detail.
- Append the same table to `$GITHUB_STEP_SUMMARY`.
- End with: `ACCEPTANCE: PASS` or `ACCEPTANCE: FAIL (n critical)`.
