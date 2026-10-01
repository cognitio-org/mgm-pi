#!/usr/bin/env python3
"""Reads the A2A TCK's JUnit report and decides the run (run-tck.sh).

usage: check_results.py <junitreport.xml> <known-defects.txt> [--report-only]

Fails (exit 1) on any failed or errored test that known-defects.txt doesn't list. A listed test that
now passes is reported, not failed, so the list can be trimmed. --report-only (the SHOULD run)
prints the same summary and always exits 0.
"""

import sys
import xml.etree.ElementTree as ET


def known_defects(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            test_id, _, reason = line.partition("#")
            out[test_id.strip()] = reason.strip()
    return out


def first_line(text):
    return (text or "").splitlines()[0][:300] if text else ""


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    report, defects_file = argv[1], argv[2]
    report_only = "--report-only" in argv[3:]
    expected = known_defects(defects_file)
    passed, skipped, failed, not_met = [], [], [], []
    for case in ET.parse(report).iter("testcase"):
        test_id = f"{case.get('classname')}::{case.get('name')}"
        skip = case.find("skipped")
        if case.find("failure") is not None or case.find("error") is not None:
            node = case.find("failure") if case.find("failure") is not None else case.find("error")
            failed.append((test_id, first_line(node.get("message") if node is not None else "")))
        elif skip is not None and skip.get("type") == "pytest.xfail":
            # The TCK marks an unmet SHOULD or MAY requirement xfail.
            not_met.append((test_id, first_line(skip.get("message"))))
        elif skip is not None:
            skipped.append(test_id)
        else:
            passed.append(test_id)

    unexpected = [(t, m) for t, m in failed if t not in expected]
    expected_failed = [t for t, _ in failed if t in expected]
    fixed = [t for t in expected if t in passed]
    print(
        f"TCK: {len(passed)} passed, {len(failed)} failed ({len(expected_failed)} known defects), "
        f"{len(not_met)} not met (xfail), {len(skipped)} skipped"
    )
    for t, m in not_met:
        print(f"  not met: {t}: {m}")
    for t in expected_failed:
        print(f"  known defect (expected fail): {t}  # {expected[t]}")
    for t in fixed:
        print(f"  listed as a known defect but passed now, trim known-defects.txt: {t}")
    for t, m in unexpected:
        print(f"  FAILED: {t}: {m}")
    if report_only:
        return 0
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
