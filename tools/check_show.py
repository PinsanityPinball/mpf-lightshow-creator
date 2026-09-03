#!/usr/bin/env python3
"""
Structural checker for MPF light-show YAML.

Validates a generated show without needing MPF or PyYAML installed, replicating
the rules mpf 0.80.x actually applies:

  * yaml_interface.YamlInterface.load compares the FIRST LINE for string
    equality against "#show_version=<n>" and raises on a mismatch.
  * assets/show.py accepts either "duration:" or "time:" per step, but not a
    "time:" in the step following one that carries a "duration:".
  * A step resolving to 0 duration is an error.
  * Util.string_to_secs treats a number with no letters as SECONDS, so
    "time: '+1'" is one second, not one frame.

Usage:
    python tools/check_show.py exports/my_show.yaml [more.yaml ...]
    python tools/check_show.py --show-version 5 legacy_show.yaml
    python tools/check_show.py --fps 30 exports/my_show.yaml

Exits non-zero if any file has an error. Warnings do not fail the run.
"""

import argparse
import re
import sys

STEP_RE = re.compile(r"^-\s*(time|duration)\s*:\s*(.+?)\s*$")
LIGHTS_RE = re.compile(r"^  (lights|light|leds)\s*:\s*$")
ENTRY_RE = re.compile(r"^    ('[^']+'|\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")
SUBKEY_RE = re.compile(r"^      ([a-z_]+)\s*:\s*(.+)$")
HEX_RE = re.compile(r"^'?([0-9A-Fa-f]{6})'?$")
VERSION_RE = re.compile(r"^#show_version=(\d+)\s*$")

# mirrors mpf.core.utility_functions.Util
def string_to_ms(t):
    t = str(t).upper()
    if t.endswith("MS") or t.endswith("MSEC"):
        return float(re.sub(r"MSE?C?$", "", t))
    if t.endswith("SEC"):
        return float(t[:-3]) * 1000
    if t.endswith("D"):
        return float(t[:-1]) * 86400 * 1000
    if t.endswith("H"):
        return float(t[:-1]) * 3600 * 1000
    if t.endswith("M"):
        return float(t[:-1]) * 60 * 1000
    if t.endswith("S"):
        return float(t[:-1]) * 1000
    return float(t)


def string_to_secs(t):
    t = str(t)
    if not any(c.isalpha() for c in t):
        t = t + "s"          # a bare number means SECONDS
    return string_to_ms(t) / 1000.0


def check(path, expect_version, fps):
    errors, warnings, notes = [], [], []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.read().splitlines()

    # --- first-line version check, exactly as MPF does it
    first = lines[0].strip() if lines else ""
    m = VERSION_RE.match(first)
    if not m:
        errors.append("line 1 is %r; MPF compares the first line to "
                      "'#show_version=%d' and refuses the file otherwise"
                      % (first, expect_version))
        found_version = None
    else:
        found_version = int(m.group(1))
        if found_version != expect_version:
            errors.append("first line is '#show_version=%d' but MPF %s expects "
                          "'#show_version=%d' - it will raise a version mismatch"
                          % (found_version, "0.57+" if expect_version == 6 else "0.50-0.56",
                             expect_version))

    steps = []          # (line_no, kind, raw_value)
    entries = 0
    lights_seen = set()
    state = "top"
    step_has_content = False
    bare_steps = 0

    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        m = STEP_RE.match(line)
        if m and line.startswith("-"):
            if state in ("step", "lights") and not step_has_content:
                bare_steps += 1
            steps.append((n, m.group(1), m.group(2).strip().strip("'\"")))
            state = "step"
            step_has_content = False
            continue

        if LIGHTS_RE.match(line):
            if state not in ("step", "lights", "entry"):
                errors.append("line %d: lights block outside a step" % n)
            # A lights: key with nothing under it parses as `lights: null`, and
            # MPF rejects the whole show with "Invalid settings for ...:lights None"
            nxt = next((x for x in lines[n:] if x.strip()
                        and not x.lstrip().startswith("#")), "")
            if not ENTRY_RE.match(nxt):
                errors.append("line %d: empty 'lights:' block - MPF reads this as "
                              "lights: null and refuses to load the show" % n)
            state = "lights"
            continue

        m = ENTRY_RE.match(line)
        if m:
            if state not in ("lights", "entry"):
                errors.append("line %d: light entry outside a lights block" % n)
            name = m.group(1).strip("'\"")
            value = m.group(2).strip()
            lights_seen.add(name)
            entries += 1
            step_has_content = True
            state = "entry"
            if value in ("", "stop", "on", "off"):
                continue
            if not HEX_RE.match(value) and not re.match(r"^[a-z_]+$", value):
                errors.append("line %d: %s: expected 6-digit hex, a colour name "
                              "or 'stop', got %r" % (n, name, value))
            continue

        m = SUBKEY_RE.match(line)
        if m:
            if state != "entry":
                errors.append("line %d: nested key outside a light entry" % n)
            key, value = m.group(1), m.group(2).strip()
            if key == "color" and not HEX_RE.match(value) and not re.match(r"^[a-z_]+$", value):
                errors.append("line %d: color expected hex or a name, got %r" % (n, value))
            if key == "fade" and not re.match(r"^\d+\s*m?s?$", value):
                errors.append("line %d: fade expected e.g. '100ms', got %r" % (n, value))
            continue

        errors.append("line %d: cannot parse %r" % (n, line))

    if state in ("step", "lights") and not step_has_content:
        bare_steps += 1
    if not steps:
        errors.append("no steps found")

    # --- timing, resolved the way MPF resolves it
    kinds = set(k for _, k, _ in steps)
    if kinds == {"time", "duration"}:
        errors.append("mixes 'time:' and 'duration:' steps; MPF rejects a 'time:' "
                      "in the step after one carrying a 'duration:'")

    total_s = 0.0
    if steps and kinds == {"duration"}:
        for n, _, value in steps:
            try:
                secs = string_to_secs(value)
            except ValueError:
                errors.append("line %d: unparseable duration %r" % (n, value)); continue
            if secs == 0:
                errors.append("line %d: step has 0 duration, which MPF rejects" % n)
            total_s += secs
    elif steps and kinds == {"time"}:
        # duration of step N comes from the time on step N+1
        for i, (n, _, value) in enumerate(steps):
            if i + 1 < len(steps):
                nxt = steps[i + 1][2]
                try:
                    secs = string_to_secs(nxt) if str(nxt).startswith("+") \
                        else string_to_secs(nxt) - total_s
                except ValueError:
                    errors.append("line %d: unparseable time %r" % (n, nxt)); continue
            else:
                secs = 1.0      # MPF defaults a trailing step to 1 unit
            total_s += secs
        rate = fps or 30
        notes.append("relative '+N' times are parsed as SECONDS: this show runs "
                     "%.1fs at the default speed, and %.2fs only if played with "
                     "speed: %d" % (total_s, total_s / rate, rate))

    print(path)
    print("  show_version=%s  steps=%d  light-entries=%d  distinct-lights=%d  bare-steps=%d"
          % (found_version, len(steps), entries, len(lights_seen), bare_steps))
    if kinds:
        print("  step timing: %s   total %.3fs" % ("/".join(sorted(kinds)), total_s))
    if bare_steps:
        warnings.append("%d step(s) carry only a time/duration and no lights" % bare_steps)
    for note in notes:
        print("  NOTE  " + note)
    for w in warnings:
        print("  WARN  " + w)
    for e in errors[:20]:
        print("  ERROR " + e)
    if len(errors) > 20:
        print("  ... and %d more errors" % (len(errors) - 20))
    print("  => %s" % ("FAIL" if errors else "OK"))
    return not errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--show-version", type=int, default=6,
                    help="version the first line must declare (default 6, MPF 0.57+)")
    ap.add_argument("--fps", type=int, default=30,
                    help="frame rate assumed when reporting legacy '+N' timing")
    args = ap.parse_args(argv)

    ok = True
    for path in args.files:
        ok = check(path, args.show_version, args.fps) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
