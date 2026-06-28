# Belay — post-deploy acceptance checklist

This is executed by a Claude cloud agent after every **production** deploy
(see `.github/workflows/acceptance.yml`). The agent is given the deployed
`BASE_URL` and may use `curl`, `python3`, and `Read`. It must run every check,
then print a **PASS/FAIL summary** and also append that summary to
`$GITHUB_STEP_SUMMARY` (write to the file path in that env var with python3).

Treat the whole run as **FAIL** if any ❗ critical check fails. Non-critical
checks (marked ⚠️) should be reported but don't fail the run.

The app is gated behind Google OAuth, so these are **headless/API-level**
acceptance checks of the critical data path. Full logged-in UI flows are a
later enhancement (would need a stored test session + a browser tool in CI).

---

## 1. Deployment is live ❗
- `GET {BASE_URL}/` → HTTP **200**, body contains `<div id="root">` and a
  `/assets/…` script tag.
- Response time < 3s.

## 2. Version sanity ⚠️
- The built JS bundle should embed the current version. Fetch `/` , find the
  main `/assets/index-*.js`, `GET` it, and confirm it contains the version
  string from `package.json` (read it with the `Read` tool). Report the version
  found vs expected.

## 3. Auth gate intact ❗
- `GET {BASE_URL}/api/me` → HTTP **401** (unauthenticated). A 200 here means the
  auth gate is broken — FAIL.

## 4. Redis replica health ❗
For each layout below, `GET {BASE_URL}/api/records?layout=<key>&db=High5_Core4&cursor=0`
and parse JSON:
- HTTP **200**, `records` array non-empty, and `meta.count > 0`.
- `meta.phase` is `idle` (a long-stuck `backfill` is ⚠️, not fail — note it).
- `meta.count` within ~10% of `meta.total`.
- `meta.lastSync` is a timestamp within the last 24h (stale sync = ⚠️).

Layouts (key → expected approx count):
- `contacts` (~15,500) ❗
- `estimates` (~2,800) ❗
- `inspections` (~4,900) ❗
- `trainings` (~2,400) ❗
- `rmi` (~110) ⚠️
- `products` (~1,260) ⚠️
- `oelookup` (~1,200) ⚠️
- `projects` (~6,400) ❗  ← Course Projects (RCD_New)

## 5. Cursor paging works ⚠️
- For `contacts`, loop pages until `cursor === "0"`; confirm the total rows
  returned ≈ `meta.total` (the full set is reachable, not just page 1).

## 6. Report
- Print a table: check, status (PASS/FAIL/WARN), detail.
- Write the same table to `$GITHUB_STEP_SUMMARY`.
- End with a single line: `ACCEPTANCE: PASS` or `ACCEPTANCE: FAIL (n critical)`.
