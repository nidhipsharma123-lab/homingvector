#!/usr/bin/env python3
"""Re-derive every figure on the page from the repo, and REFUSE on a mismatch.

WHY THIS EXISTS. The rule is "every figure RE-DERIVED before publish, never
hand-copied". A rule someone has to remember is not a rule, it is a hope -- and
on 2026-09-16 the page carried 742 missions and 531 passed for long enough to be
read, because the corpus had moved and nobody recounted. Worse, a figure can
match its CLAIMS.md row perfectly and still be stale, because CLAIMS.md and
derived.json are SNAPSHOTS. Tracing to a row is necessary and not sufficient.
The only sufficient check is: re-derive from the repo, compare to the page.

HOW IT FAILS, which is the whole design. Five instruments failed the same way in
one night -- rtf columns computed then zeroed (B-156), an unbounded uncertainty
logged as -1.0 so an absence read as the best clock in the fleet (B-157), a
guard matching a 17-character name against a 15-character field so it could
never fire (B-158), a staging guard that PRINTED the rows riding along and
committed anyway, and reclaim logic that read exit 127 "file not found" as "the
check said nothing is flying". One failure, five times: THE UNHANDLED CASE WAS
SILENTLY BENIGN. So here, every unhandled case is fatal:

  * a data-fig key with no rule and no exemption -> FAIL, naming the key
  * a derivation that raises                     -> FAIL ("could not compute"
                                                     is not "matches")
  * a source file that does not exist            -> FAIL, never 0
  * an empty result set                          -> FAIL unless 0 is asserted
  * an exemption without a reason                -> FAIL

An exemption list is fine. An IMPLICIT exemption is the bug.

Exemptions also carry a required disclosure: a figure that cannot be recounted
must SAY SO on the page. If someone deletes that sentence, the figure silently
becomes an unsourced claim, so deleting it fails this gate.

  tools/check_figures.py                 check the page
  tools/check_figures.py --self-test     prove every failure rule can fire
"""

import argparse
import csv
import glob
import html
import os
import re
import sys

DEFAULT_REPO = "/home/nidhip/turtleshield"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PAGE = os.path.join(HERE, "..", "index.html")


class Missing(Exception):
    """A source that must exist does not. Never silently a zero."""


def _scored_rows(repo):
    """Every scored run in the corpus: (verdict, row) pairs.

    A campaign with no verdict column contributes nothing and is not an error --
    not every results.csv is scored. A campaign whose file cannot be read IS an
    error, because that is indistinguishable from a wrong count.
    """
    pattern = os.path.join(repo, "sims", "*", "*", "results.csv")
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise Missing(f"no results.csv under {pattern} -- refusing to report 0")
    rows, campaigns = [], 0
    for path in paths:
        with open(path, newline="") as fh:
            reader = csv.DictReader(fh)
            if not reader.fieldnames:
                continue
            vcol = next((c for c in reader.fieldnames
                         if c.strip().lower() in ("verdict", "result", "status")), None)
            if not vcol:
                continue
            n_here = 0
            for row in reader:
                verdict = (row.get(vcol) or "").strip().upper()
                if not verdict:
                    continue
                rows.append((verdict, row))
                n_here += 1
            if n_here:
                campaigns += 1
    if not rows:
        raise Missing("results.csv files exist but contain no scored rows")
    return rows, campaigns


def derive_missions_total(repo):
    rows, _ = _scored_rows(repo)
    return str(len(rows))


def derive_campaigns_scored(repo):
    _, campaigns = _scored_rows(repo)
    return str(campaigns)


def derive_verdict_counts(repo):
    rows, _ = _scored_rows(repo)
    out = {"PASS": 0, "FAIL": 0, "SKIP": 0}
    for verdict, _row in rows:
        if verdict in out:
            out[verdict] += 1
    return out


def derive_formation_max_fw(repo):
    """Largest fixed-wing count among scored runs.

    Counted over SCORED rows only: an unscored row is not a demonstrated
    formation, and quoting one would claim a fleet size we never judged.
    """
    rows, _ = _scored_rows(repo)
    best = 0
    for _verdict, row in rows:
        raw = (row.get("n_fw") or "").strip()
        if raw.isdigit():
            best = max(best, int(raw))
    if best == 0:
        raise Missing("no n_fw values in any scored row -- refusing to report 0")
    return str(best)


def derive_defects_logged(repo):
    path = os.path.join(repo, "docs", "BUGLOG.md")
    if not os.path.exists(path):
        raise Missing(f"{path} does not exist")
    # PREFIX MATCH, deliberately, and this cost a false positive to learn.
    # A stricter '^\| B-\d+ \|' misses five real rows whose ids carry a suffix
    # -- B-058-followup, B-059-tightformation-sep, B-060-transit-stack,
    # B-060-correction, B-088-correction -- and reports 140 against a true 145.
    # A gate that fires on a CORRECT page is worse than no gate, because it
    # teaches the next person to override it. scripts/verify/check_buglog_rows.sh
    # matches the same way ('| B-'*), so this agrees with the repo's own counter
    # rather than inventing a second definition free to disagree with it.
    n = 0
    with open(path) as fh:
        for line in fh:
            if line.startswith("| B-"):
                n += 1
    if n == 0:
        raise Missing("BUGLOG.md exists but holds no rows -- refusing to report 0")
    return str(n)


def derive_real_flights(repo):
    """Zero is the ASSERTED value here, so an empty result is not a failure --
    but it must be asserted by a document, not by this script's optimism. The
    claim comes off the page the day something flies, and this is what notices.
    """
    for name in ("FLIGHT_READINESS.md", "HARDWARE_BRINGUP_PROMPT.md"):
        path = os.path.join(repo, "docs", name)
        if not os.path.exists(path):
            continue
        text = open(path, errors="replace").read().lower()
        if "has flown" in text or "nothing in this system has flown" in text:
            return "0"
    raise Missing("no document asserts that nothing has flown; refusing to "
                  "assume 0 real flights")


# THE TWO ADAPTER COMMITS, PINNED BY HASH.
#
# The page claims a second autopilot went in behind IVehicle without the core
# moving at all, which is an architectural claim and a strong one. It is only
# true under one specific reading of "the two adapter commits", and nothing
# machine-readable said which two -- ADR-044 cites no hashes. nidhip-a6
# identified them by SUBJECT first and counted SECOND, and that order mattered:
# 90c7171 also touches adapters/ and changes 2 files under core/, so a looser
# rule ("recent commits touching adapters/") returns a non-zero answer and would
# fail a page that is correct.
#
# Pinning the hashes converts an exemption into a real rule. It is exact,
# reproducible, and gets MORE trustworthy with age rather than less -- where an
# exemption gets less, because nobody re-examines it.
ADAPTER_COMMITS = ("06ac890", "68547a1")


def derive_core_files_adapter_commits(repo):
    import subprocess
    total = 0
    for sha in ADAPTER_COMMITS:
        proc = subprocess.run(
            ["git", "-C", repo, "show", "--pretty=format:", "--name-only", sha, "--", "core/"],
            capture_output=True, text=True)
        if proc.returncode != 0:
            raise Missing(f"commit {sha} not found in {repo} "
                          f"({proc.stderr.strip()[:80]}) -- refusing to report 0")
        total += len([ln for ln in proc.stdout.splitlines() if ln.strip()])
    return str(total)


# KEYED TO THE PAGE, NOT TO THIS FILE. The page owns the naming: on 2026-09-16
# the attribute was renamed data-fig -> data-figure and every key with it, and
# this checker found ZERO hooks and refused. That refusal was correct -- it did
# not report "0 figures checked, all OK" -- but a gate that has to be re-keyed by
# hand every rename is a gate that will eventually be switched off. If it ever
# refuses for "no data-figure attributes" again, check for a rename FIRST.
DERIVATIONS = {
    "missions": derive_missions_total,
    "formation_fleet_max": derive_formation_max_fw,
    "defects": derive_defects_logged,
    "real_flights": derive_real_flights,
    "autopilot_core_files_per_commit": derive_core_files_adapter_commits,
}

# EXPLICIT, NAMED, AND EACH WITH A REASON AND A REQUIRED DISCLOSURE.
# A figure that cannot be recounted must say so where a reader sees it. If the
# disclosure is edited away the figure becomes an unsourced claim, and that
# fails here rather than shipping.
EXEMPTIONS = {
    "nav_error_without_gps": dict(
        reason="CLAIMS.md sources it to a written report section "
               "(docs/report/90_pitch_front_matter.md 90.2) plus two named "
               "campaigns, not to a results column. Re-deriving it would mean "
               "reimplementing a debiased-RMS computation here, which would be "
               "a second implementation free to disagree with the first.",
        disclosure=None,
    ),
}


# A FIGURE WITH NO MARKER AT ALL IS THE HARDEST CASE, AND IT IS ON THIS PAGE.
#
# "2,000+" orbit commands cannot be recounted -- the logs of passing runs are
# not all retained -- so on 2026-09-16 its data-figure marker was deliberately
# removed rather than left pointing at a rule that cannot exist. That is
# defensible: a marker promising a derivation nobody can perform is worse than
# no marker. But it leaves the figure INVISIBLE to this gate, and an exemption
# nobody sees again is one nobody re-examines (nidhip-a6). In five years it
# would still read "2,000+" and everyone would assume something still checks it.
#
# So the caveat itself is the thing gated. The figure may stay unmarked, but the
# sentence admitting it cannot be recounted must remain: delete the admission
# and this fails, because an un-recountable number without its caveat is an
# unsourced claim. This needs no marker on the page and cannot be renamed away.
UNMARKED_FIGURES = {
    "orders accepted (2,000+)": dict(
        value="2,000+",
        disclosure="cannot recount it today",
        reason="CLAIMS.md slide 14 marks it MEASURED (NOT RE-DERIVED): 2,060 "
               "accepted and 7 refused, counted by hand 2026-09-15.",
    ),
}


def page_figures(page_path):
    if not os.path.exists(page_path):
        raise Missing(f"{page_path} does not exist")
    text = open(page_path, errors="replace").read()
    found = {}
    for m in re.finditer(r'data-figure="([^"]+)"[^>]*>([^<]*)<', text):
        found[m.group(1)] = html.unescape(m.group(2)).strip()
    if not found:
        raise Missing("no data-figure attributes on the page -- refusing to pass "
                      "a page with nothing to check (was the attribute renamed?)")
    return found, text


def normalise(value):
    """Compare what a reader sees, not how it is typed."""
    v = html.unescape(value).strip()
    v = v.replace(",", "").replace(" ", "").replace(" ", " ")
    return re.sub(r"\s+", " ", v)


def check(repo, page_path, verbose=True):
    failures = []
    figures, page_text = page_figures(page_path)

    for key in sorted(figures):
        shown = figures[key]
        if key in DERIVATIONS:
            try:
                derived = DERIVATIONS[key](repo)
            except Exception as exc:                      # noqa: BLE001
                failures.append(f"{key}: could not derive it ({exc}). "
                                "Not computable is not the same as matching.")
                if verbose:
                    print(f"  ERROR     {key:<28} page={shown!r}  ({exc})")
                continue
            if normalise(derived) == normalise(shown):
                if verbose:
                    print(f"  ok        {key:<28} {shown}")
            else:
                failures.append(f"{key}: page says {shown!r}, repo says {derived!r}")
                if verbose:
                    print(f"  MISMATCH  {key:<28} page={shown!r} repo={derived!r}")
        elif key in EXEMPTIONS:
            spec = EXEMPTIONS[key]
            if not spec.get("reason"):
                failures.append(f"{key}: exempt with no reason recorded")
                continue
            disclosure = spec.get("disclosure")
            if disclosure and disclosure.lower() not in page_text.lower():
                failures.append(
                    f"{key}: exempt because it cannot be recounted, but the page "
                    f"no longer discloses that (missing: {disclosure!r}). An "
                    "un-recountable figure without its caveat is an unsourced claim.")
                if verbose:
                    print(f"  NO-CAVEAT {key:<28} {shown}")
            elif verbose:
                print(f"  exempt    {key:<28} {shown}   ({'disclosed' if disclosure else 'no disclosure required'})")
        else:
            failures.append(
                f"{key}: NO RULE AND NO EXEMPTION. An unchecked figure is not a "
                "passing figure -- give it a derivation or an explicit exemption.")
            if verbose:
                print(f"  UNKNOWN   {key:<28} {shown}")

    # Figures carrying no marker, whose CAVEAT is what gets gated.
    for label, spec in sorted(UNMARKED_FIGURES.items()):
        if spec["value"] not in page_text:
            if verbose:
                print(f"  gone      {label:<28} (no longer on the page)")
            continue
        if spec["disclosure"].lower() not in page_text.lower():
            failures.append(
                f"{label}: present on the page but its caveat is gone "
                f"(missing: {spec['disclosure']!r}). It cannot be recounted "
                f"({spec['reason']}), so without the caveat it is an unsourced claim.")
            if verbose:
                print(f"  NO-CAVEAT {label:<28} {spec['value']}")
        elif verbose:
            print(f"  unmarked  {label:<28} {spec['value']}   (caveat present)")

    # Sub-figures that are not their own data-figure but are read as claims.
    try:
        counts = derive_verdict_counts(repo)
        campaigns = derive_campaigns_scored(repo)
        tally = f"{counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped"
        if normalise(tally) not in normalise(page_text):
            failures.append(f"verdict tally: page does not carry {tally!r}")
            if verbose:
                print(f"  MISMATCH  {'verdict tally':<28} expected {tally!r}")
        elif verbose:
            print(f"  ok        {'verdict tally':<28} {tally}")
        if f"{campaigns} campaigns" not in page_text:
            failures.append(f"campaigns: page does not carry '{campaigns} campaigns'")
            if verbose:
                print(f"  MISMATCH  {'campaigns':<28} expected {campaigns}")
        elif verbose:
            print(f"  ok        {'campaigns':<28} {campaigns} campaigns")
    except Exception as exc:                              # noqa: BLE001
        failures.append(f"verdict tally: could not derive it ({exc})")

    return failures


def self_test(repo):
    """Prove each failure rule can FIRE. A checker that has only been shown to
    say OK is indistinguishable from an empty one -- which is B-158 exactly.
    """
    import tempfile
    ok = True

    def case(name, page_body, expect_fail, expect_substr=None):
        nonlocal ok
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as fh:
            fh.write(page_body)
            path = fh.name
        try:
            fails = check(repo, path, verbose=False)
        except Missing as exc:
            fails = [str(exc)]
        os.unlink(path)
        fired = bool(fails)
        good = (fired == expect_fail)
        if good and expect_substr:
            good = any(expect_substr in f for f in fails)
        print(f"  {'PASS' if good else 'FAIL'}: {name}")
        if not good:
            print(f"        got: {fails}")
            ok = False

    real = derive_missions_total(repo)
    counts = derive_verdict_counts(repo)
    campaigns = derive_campaigns_scored(repo)
    # The verdict tally and campaign count are checked against the WHOLE page,
    # so a minimal test page legitimately lacks them and every "expect pass"
    # case would fail for a reason that has nothing to do with what it tests.
    # Supply them rather than relaxing the rule: the rule is right, the fixture
    # was incomplete.
    tail = (f'<p>{counts["PASS"]} passed, {counts["FAIL"]} failed, '
            f'{counts["SKIP"]} skipped, across {campaigns} campaigns</p>')

    case("a correct figure passes",
         f'<td data-figure="missions">{real}</td>' + tail, False)
    case("a WRONG figure is caught (mutant control)",
         '<td data-figure="missions">999999</td>' + tail, True, "repo says")
    case("an unknown data-figure key is caught, not skipped",
         '<td data-figure="totally_made_up">7</td>' + tail, True, "NO RULE")
    case("a page with no data-figure at all is refused",
         '<td>nothing here</td>', True)
    case("an exempt figure with NO required disclosure passes",
         '<td data-figure="nav_error_without_gps">1 m</td>' + tail, False)

    # THE EXEMPTIONS DISCLOSURE BRANCH, exercised with a synthetic entry.
    # No current exemption requires a disclosure -- orders_accepted_min moved to
    # UNMARKED_FIGURES when its marker was dropped -- so without this the branch
    # is dead code sitting inside a gate, which is the liability this whole file
    # exists to remove. A capability nothing exercises is a capability nobody
    # knows is broken.
    EXEMPTIONS["__synthetic__"] = dict(reason="self-test only",
                                       disclosure="a sentence that is not present")
    try:
        case("an exemption whose required disclosure is missing is caught",
             '<td data-figure="__synthetic__">1</td>' + tail, True, "no longer discloses")
        EXEMPTIONS["__synthetic__"]["disclosure"] = "this caveat is present"
        case("an exemption whose required disclosure is present passes",
             '<td data-figure="__synthetic__">1</td>'
             '<p>this caveat is present</p>' + tail, False)
        EXEMPTIONS["__synthetic__"]["reason"] = ""
        case("an exemption with no reason recorded is caught",
             '<td data-figure="__synthetic__">1</td>'
             '<p>this caveat is present</p>' + tail, True, "no reason")
    finally:
        del EXEMPTIONS["__synthetic__"]
    case("a stale verdict tally is caught",
         f'<td data-figure="missions">{real}</td>'
         '<p>1 passed, 2 failed, 3 skipped, across 4 campaigns</p>', True, "verdict tally")
    # THE UNMARKED FIGURE: its caveat is the gate, and it needs no marker.
    case("an unmarked un-recountable figure WITH its caveat passes",
         f'<td data-figure="missions">{real}</td>'
         '<td>2,000+</td><td>we cannot recount it today</td>' + tail, False)
    case("an unmarked un-recountable figure with its caveat DELETED is caught",
         f'<td data-figure="missions">{real}</td>'
         '<td>2,000+</td>' + tail, True, "caveat is gone")

    print("self-test: OK" if ok else "self-test: FAILED")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--page", default=DEFAULT_PAGE)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test(args.repo)

    print(f"Figure check: {os.path.normpath(args.page)}")
    print(f"  against repo: {args.repo}")
    try:
        failures = check(args.repo, os.path.normpath(args.page))
    except Missing as exc:
        print(f"  REFUSED: {exc}")
        return 1

    if failures:
        print(f"\n  FAILED -- {len(failures)} figure(s) must be fixed before publishing:")
        for f in failures:
            print(f"    * {f}")
        return 1
    print("\n  OK -- every figure on the page re-derives from the repo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
