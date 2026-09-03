#!/usr/bin/env python3
"""
Pinlandia Show Creator - local launcher.

Serves the web UI and provides file access to the project folders.
Standard library only: no pip install required.

    python server.py [--port 8777] [--no-browser] [--root DIR] [--machine DIR]

Folders (relative to this file unless --root is given):
    web/        the app itself
    shapes/     PNG shape images
    lightmaps/  monitor.yaml style light position files
    shows/      saved projects (.json)
    imports/    MPF show YAML brought in for reuse
    exports/    generated MPF show YAML
    backgrounds/ playfield images used as a tracing guide

Remembered choices (light map, tags file, export target, machine folder,
background) live in config.json and are restored when the app next opens.
"""

import base64

import argparse
import json
import mimetypes
import os
import posixpath
import re
import sys
import threading
import time
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
STARTED_AT = time.time()

# The page beats every few seconds. When the beats stop the window is gone and
# there is nothing left for the server to serve, so it exits rather than piling
# up orphaned processes - which also go stale, still answering requests with
# whatever routes existed when they started.
CLIENT = {
    "last": 0.0,      # time of the most recent beat
    "seen": False,    # a page has connected at least once
    "deadline": 0.0,  # set by /api/bye so a closed window exits sooner
}
IDLE_TIMEOUT = 25.0   # no beats for this long -> quit
BYE_GRACE = 6.0       # after a page says it is going -> quit unless one returns

DIRS = {
    "web": "web",
    "shapes": "shapes",
    "lightmaps": "lightmaps",
    "shows": "shows",
    "imports": "imports",
    "exports": "exports",
    "backgrounds": "backgrounds",
}

ROOT = HERE
# Remembered between sessions in config.json next to this file.
CONFIG = {
    "machineFolder": "",
    "lightMap": "",
    "tagFile": "",
    "exportTarget": "exports",
    "background": "",
    "folders": [],
    # Light maps and tag files picked from elsewhere on disk, kept as absolute
    # paths so they stay listed in the dropdowns without being copied in.
    "recentMaps": [],
    "recentTags": [],
}

# Names we are willing to read or write. Keeps path traversal out.
SAFE_NAME = re.compile(r"^[A-Za-z0-9 ._()-]+$")


def path_for(kind, name=None):
    base = os.path.join(ROOT, DIRS[kind])
    if name is None:
        return base
    name = unquote(name)
    if not SAFE_NAME.match(name) or name in (".", ".."):
        raise ValueError("unsafe name: %r" % name)
    return os.path.join(base, name)


def external_yaml(name):
    """An absolute path to a YAML file the user picked, or None.

    Files under lightmaps/ are referred to by bare name and guarded by
    SAFE_NAME. A name that is instead an absolute path is one the user chose in
    the file browser, so it is allowed - but only ever a .yaml/.yml, never an
    arbitrary file, and it has to actually exist.
    """
    if not name:
        return None
    try:
        expanded = os.path.expandvars(os.path.expanduser(unquote(name)))
    except Exception:
        return None
    if not os.path.isabs(expanded):
        return None
    if not expanded.lower().endswith((".yaml", ".yml")):
        return None
    full = os.path.abspath(expanded)
    return full if os.path.isfile(full) else None


def lightmap_path(name):
    """Resolve a light map or tag file name to a full path.

    Accepts either a bare name inside lightmaps/ or an absolute path to a YAML
    file elsewhere on disk.
    """
    return external_yaml(name) or path_for("lightmaps", name)


def remember_external(key, path):
    """Keep an externally-picked file in the dropdown for next time."""
    if not path or not os.path.isabs(path):
        return
    recent = [p for p in CONFIG.get(key, [])
              if os.path.normcase(p) != os.path.normcase(path)]
    recent.insert(0, path)
    CONFIG[key] = recent[:12]
    save_config()


def prune_external(key):
    """Drop remembered paths whose file has since gone away."""
    recent = [p for p in CONFIG.get(key, []) if os.path.isfile(p)]
    if len(recent) != len(CONFIG.get(key, [])):
        CONFIG[key] = recent
        save_config()
    return recent


def browse_places():
    """Sensible starting points: drives, home, and the app's own folders."""
    out = []
    home = os.path.expanduser("~")
    if os.path.isdir(home):
        out.append({"name": "Home", "path": home})
    for label, sub in (("Desktop", "Desktop"), ("Documents", "Documents"),
                       ("Downloads", "Downloads")):
        full = os.path.join(home, sub)
        if os.path.isdir(full):
            out.append({"name": label, "path": full})

    maps = path_for("lightmaps")
    if os.path.isdir(maps):
        out.append({"name": "This app's lightmaps folder", "path": maps})

    if os.name == "nt":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = "%s:\\" % letter
            if os.path.isdir(drive):
                out.append({"name": "%s: drive" % letter, "path": drive})
    else:
        out.append({"name": "/", "path": "/"})

    # machine folders already known, since a monitor.yaml often lives in one
    for folder in CONFIG.get("folders", []):
        if os.path.isdir(folder):
            out.append({"name": os.path.basename(folder) or folder, "path": folder})
    return out


def browse_crumbs(path):
    """Breadcrumb trail for a path, root first."""
    crumbs = []
    head = os.path.abspath(path)
    while True:
        # no rstrip: on Windows "C:\\" is its own dirname, which is how the
        # walk terminates. Stripping the separator gives "C:", a different
        # string, and the loop emits the drive twice.
        parent = os.path.dirname(head)
        name = os.path.basename(head) or head
        crumbs.append({"name": name, "path": head})
        if not parent or parent == head:
            break
        head = parent
    crumbs.reverse()
    return crumbs


def ensure_dirs():
    for kind in DIRS:
        os.makedirs(os.path.join(ROOT, DIRS[kind]), exist_ok=True)


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def config_path():
    return os.path.join(ROOT, "config.json")


def load_config():
    global CONFIG
    try:
        with open(config_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            CONFIG.update(data)
    except (OSError, ValueError):
        pass


def save_config():
    with open(config_path(), "w", encoding="utf-8") as fh:
        json.dump(CONFIG, fh, indent=1)


def machine_shows_dir(folder=None, create=False):
    """Resolve where shows should be written inside an MPF machine folder.

    An MPF machine root contains config/; its shows live in <root>/shows/.
    If the folder given is not a machine root it is used as-is.
    """
    folder = folder if folder is not None else CONFIG.get("machineFolder", "")
    if not folder:
        raise ValueError("no machine folder configured")
    root = os.path.abspath(os.path.expandvars(os.path.expanduser(folder)))
    if not os.path.isdir(root):
        raise ValueError("machine folder does not exist: %s" % root)
    if os.path.isdir(os.path.join(root, "config")):
        target = os.path.join(root, "shows")
    else:
        target = root
    if create:
        os.makedirs(target, exist_ok=True)
    return target


def looks_like_machine(path):
    """An MPF machine root has config/config.yaml.

    Requiring that exact name is what separates a machine from a mode folder:
    modes also carry a config/ but name the file after the mode.
    """
    cfg = os.path.join(path, "config")
    if not os.path.isdir(cfg):
        return False
    return any(os.path.isfile(os.path.join(cfg, n))
               for n in ("config.yaml", "config.yml"))


def describe_folder(path):
    """Resolve one destination folder for the UI."""
    entry = {"path": path, "showsDir": "", "ok": False, "machine": False}
    try:
        entry["showsDir"] = machine_shows_dir(path)
        entry["ok"] = True
        entry["machine"] = looks_like_machine(
            os.path.abspath(os.path.expandvars(os.path.expanduser(path))))
    except ValueError as exc:
        entry["message"] = str(exc)
    return entry


def discover_machines(limit=400):
    """Look for MPF machine folders in a few likely places.

    Deliberately shallow: a handful of roots, two levels deep, with a hard cap
    on how many directories are examined. Anything else the user adds by hand.
    """
    home = os.path.expanduser("~")
    roots = [
        os.path.dirname(ROOT),
        home,
        os.path.join(home, "Documents"),
        os.path.join(home, "Desktop"),
    ]
    if os.name == "nt":
        roots += ["%s:\\" % d for d in "CDE" if os.path.isdir("%s:\\" % d)]

    found = []
    seen = set()
    examined = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        try:
            level1 = sorted(os.listdir(root))
        except OSError:
            continue
        for name in level1:
            if examined >= limit:
                break
            if name.startswith(".") or name.startswith("$"):
                continue
            p1 = os.path.join(root, name)
            if not os.path.isdir(p1):
                continue
            examined += 1
            if looks_like_machine(p1) and p1 not in seen:
                seen.add(p1)
                found.append(p1)
                continue
            # one level deeper, e.g. ~/Documents/pinball/my_machine
            try:
                level2 = sorted(os.listdir(p1))
            except OSError:
                continue
            for sub in level2:
                if examined >= limit:
                    break
                p2 = os.path.join(p1, sub)
                if not os.path.isdir(p2) or sub.startswith("."):
                    continue
                examined += 1
                if looks_like_machine(p2) and p2 not in seen:
                    seen.add(p2)
                    found.append(p2)
    return found


# ---------------------------------------------------------------------------
# monitor.yaml light-map parsing
# ---------------------------------------------------------------------------

def parse_lightmap(text):
    """Pull the `light:` section out of an MPF monitor yaml.

    Mirrors what the original BlitzMax SetUpLeds2() accepted: a light name at
    one indent level, then any of shape/size/rotation/x/y beneath it. Returns
    a list of dicts with normalised 0..1 x/y.
    """
    lights = []
    in_section = False
    state = {"current": None}

    def flush():
        current = state["current"]
        if current and "x" in current and "y" in current:
            lights.append({
                "name": current["name"],
                "x": current["x"],
                "y": current["y"],
                "shape": str(current.get("shape", "circle")).strip().lower(),
                "size": current.get("size", 0.05),
                "rotation": current.get("rotation", 0.0),
            })

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()

        if indent == 0:
            flush()
            state["current"] = None
            in_section = stripped in ("light:", "lights:", "leds:")
            continue

        if not in_section or ":" not in stripped:
            continue

        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip().strip("'").strip('"')

        if value == "":
            flush()
            state["current"] = {"name": key}
            continue

        current = state["current"]
        if current is None:
            continue

        if key in ("x", "y", "size", "rotation"):
            try:
                current[key] = float(value)
            except ValueError:
                pass
        elif key == "shape":
            current[key] = value

    flush()
    return lights


def parse_light_tags(text):
    """Pull `tags:` out of an MPF `lights:` config section.

        lights:
          l_left_ramp:
            number:
            tags: all, shot, left_ramp

    Returns {light_name: [tag, ...]}. Tags split on commas and whitespace, so a
    missing comma ("all, 5x 4x") still yields separate tags rather than one
    unusable compound.
    """
    tags = {}
    in_section = False
    current = None

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()

        if indent == 0:
            current = None
            in_section = stripped in ("lights:", "light:")
            continue
        if not in_section or ":" not in stripped:
            continue

        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip().strip("'").strip('"')

        if indent <= 2 and value == "":
            current = key
            tags.setdefault(current, [])
            continue
        if current is None:
            continue
        if key == "tags" and value:
            parts = [t for t in re.split(r"[,\s]+", value) if t]
            tags[current] = parts

    return tags


def find_tag_file(lightmap_name):
    """Guess the lights.yaml that goes with a monitor.yaml, by stem.

    For a map picked from elsewhere on disk, the partner is looked for beside
    it rather than in lightmaps/, and comes back as an absolute path.
    """
    ext = external_yaml(lightmap_name)
    base = os.path.dirname(ext) if ext else path_for("lightmaps")
    lightmap_name = os.path.basename(lightmap_name) if ext else lightmap_name
    stem = re.sub(r"\.(yaml|yml)$", "", lightmap_name, flags=re.I)
    stem = re.sub(r"(^|[_-])monitor([_-]|$)", r"\1", stem, flags=re.I).strip("_-")
    candidates = []
    if stem:
        candidates += ["%s_lights.yaml" % stem, "lights_%s.yaml" % stem, "%s.lights.yaml" % stem]
    candidates.append("lights.yaml")
    for name in candidates:
        full = os.path.join(base, name)
        if os.path.isfile(full):
            return full if ext else name
    return None


def file_mtime(kind, name):
    """Modification time of a file, or 0 when it is not there."""
    if not name:
        return 0
    try:
        full = lightmap_path(name) if kind == "lightmaps" else path_for(kind, name)
        return int(os.path.getmtime(full) * 1000)
    except (OSError, ValueError):
        return 0


def load_tags(name):
    if not name:
        return {}
    try:
        full = lightmap_path(name)
    except ValueError:
        return {}
    if not os.path.isfile(full):
        return {}
    with open(full, "r", encoding="utf-8", errors="replace") as fh:
        return parse_light_tags(fh.read())


def looks_like_tagfile(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(8192)
    except OSError:
        return False
    return re.search(r"^\s*tags\s*:", head, re.M) is not None


def looks_like_lightmap(path):
    """True for a monitor.yaml - a light block that carries positions.

    A machine's lights.yaml also opens with a "lights:" block, so the block
    header alone is not enough to tell them apart. The thing that makes a file
    a light *map* is per-light x/y, which is what this app samples against; a
    lights.yaml has tags instead and no coordinates at all.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(16384)
    except OSError:
        return False
    if re.search(r"^(light|lights|leds):\s*$", head, re.M) is None:
        return False
    return re.search(r"^\s+x\s*:", head, re.M) is not None


def sniff_kind(path):
    """Label a YAML for the file browser.

    'both' matters: a machine's lights.yaml often carries per-light x/y as well
    as tags, so one file serves as light map and tag file at once. Reporting
    that as merely a 'map' made it invisible in the tag picker.
    """
    is_map = looks_like_lightmap(path)
    is_tags = looks_like_tagfile(path)
    if is_map and is_tags:
        return "both"
    if is_map:
        return "map"
    if is_tags:
        return "tags"
    return "yaml"


# ---------------------------------------------------------------------------
# MPF show parsing
# ---------------------------------------------------------------------------

NAMED_COLOURS = {
    "white": "FFFFFF", "black": "000000", "red": "FF0000", "green": "00FF00",
    "blue": "0000FF", "yellow": "FFFF00", "orange": "FF8000", "purple": "800080",
    "magenta": "FF00FF", "cyan": "00FFFF", "pink": "FF80C0", "lime": "80FF00",
    "off": "000000", "on": "FFFFFF",
}

STEP_LINE = re.compile(r"^-\s*time\s*:\s*(.+?)\s*$")


def _normalise_colour(value, warnings):
    """Turn an MPF light value into RRGGBB, or None for 'stop'."""
    v = str(value).strip().strip("'").strip('"')
    if v == "":
        return None
    low = v.lower()
    if low in ("stop", "off"):
        return None
    if low in NAMED_COLOURS:
        return NAMED_COLOURS[low]
    if re.match(r"^[0-9A-Fa-f]{6}$", v):
        return v.upper()
    if re.match(r"^[0-9A-Fa-f]{3}$", v):
        return "".join(c * 2 for c in v).upper()
    if len(warnings) < 20:
        warnings.append("unrecognised colour %r, treated as white" % v)
    return "FFFFFF"


def parse_mpf_show(text):
    """Parse an MPF light show into absolute-indexed steps.

    Returns {'steps': [{'index': int, 'lights': {name: 'RRGGBB' or None}}],
             'lightNames': [...], 'frames': int, 'warnings': [...]}
    'None' means the light is switched off (a 'stop' entry).
    """
    steps = []
    warnings = []
    light_names = []
    seen = set()

    cur = None            # current step dict
    section = None        # which block we are inside ('lights' or something else)
    entry_name = None     # light name awaiting nested keys
    index = -1

    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        m = STEP_LINE.match(stripped)
        if m and line.lstrip().startswith("-"):
            t = m.group(1).strip().strip("'").strip('"')
            if index < 0:
                try:
                    index = int(t.lstrip("+")) if t.lstrip("+").isdigit() else 0
                except ValueError:
                    index = 0
            elif t.startswith("+"):
                try:
                    index += int(t[1:])
                except ValueError:
                    index += 1
            elif t.rstrip("ms").isdigit():
                try:
                    index = int(t.rstrip("ms"))
                except ValueError:
                    index += 1
            else:
                index += 1
            cur = {"index": index, "lights": {}}
            steps.append(cur)
            section = None
            entry_name = None
            continue

        if cur is None:
            continue

        indent = len(line) - len(line.lstrip())

        # a block header such as "lights:" / "flashers:" / "sounds:"
        if indent <= 2 and stripped.endswith(":") and ":" in stripped:
            key = stripped[:-1].strip()
            section = "lights" if key in ("lights", "light", "leds") else key
            entry_name = None
            continue

        if section != "lights":
            continue

        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip().strip("'").strip('"')
        value = value.strip()

        if indent >= 6 and entry_name is not None:
            # nested form: color: / fade:
            if key == "color":
                cur["lights"][entry_name] = _normalise_colour(value, warnings)
            continue

        if value == "":
            entry_name = key
            cur["lights"].setdefault(key, "FFFFFF")
            if key not in seen:
                seen.add(key)
                light_names.append(key)
            continue

        entry_name = None
        cur["lights"][key] = _normalise_colour(value, warnings)
        if key not in seen:
            seen.add(key)
            light_names.append(key)

    frames = (steps[-1]["index"] + 1) if steps else 0
    return {
        "steps": steps,
        "lightNames": light_names,
        "frames": frames,
        "warnings": warnings,
    }


def best_map_for(names):
    """Find the light map that knows most of these light names.

    An MPF show yaml carries no positions, so re-mapping an imported show onto
    a different machine needs to learn them from somewhere. The map that names
    the most of the show's lights is the one it was authored against.
    """
    wanted = set(names)
    if not wanted:
        return None, {}
    base = path_for("lightmaps")
    best_name, best_hits, best_pos = None, 0, {}
    if not os.path.isdir(base):
        return None, {}
    for n in sorted(os.listdir(base)):
        if not n.lower().endswith((".yaml", ".yml")):
            continue
        full = os.path.join(base, n)
        if not looks_like_lightmap(full):
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                lights = parse_lightmap(fh.read())
        except OSError:
            continue
        pos = {}
        for l in lights:
            if l["name"] in wanted:
                pos[l["name"]] = [round(l["x"], 4), round(l["y"], 4)]
        if len(pos) > best_hits:
            best_name, best_hits, best_pos = n, len(pos), pos
    return best_name, best_pos


def looks_like_show(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(4096)
    except OSError:
        return False
    if "show_version" in head:
        return True
    return re.search(r"^-\s*time\s*:", head, re.M) is not None


def list_show_files():
    """Every MPF show yaml we can offer for import, tagged by source."""
    out = []
    for src in ("imports", "exports"):
        base = path_for(src)
        if not os.path.isdir(base):
            continue
        for n in sorted(os.listdir(base)):
            if n.lower().endswith((".yaml", ".yml")) and looks_like_show(os.path.join(base, n)):
                out.append({"source": src, "name": n})
    try:
        target = machine_shows_dir()
        if os.path.isdir(target):
            for n in sorted(os.listdir(target)):
                if n.lower().endswith((".yaml", ".yml")) and looks_like_show(os.path.join(target, n)):
                    out.append({"source": "machine", "name": n})
    except ValueError:
        pass
    return out


def resolve_show_file(source, name):
    if not SAFE_NAME.match(unquote(name)):
        raise ValueError("unsafe name: %r" % name)
    name = unquote(name)
    if source == "machine":
        base = machine_shows_dir()
    elif source in ("imports", "exports"):
        base = path_for(source)
    else:
        raise ValueError("unknown source: %r" % source)
    full = os.path.join(base, name)
    if not os.path.isfile(full):
        raise ValueError("no such show: %s" % name)
    return full


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "ShowCreator/1.1"
    verbose = False

    def log_message(self, fmt, *args):
        if Handler.verbose:
            SimpleHTTPRequestHandler.log_message(self, fmt, *args)

    # -- helpers ----------------------------------------------------------

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    # -- file browser -----------------------------------------------------

    def handle_browse(self, query):
        """List one folder so the UI can walk the disk and pick a YAML.

        Read-only, and only ever reports directories plus .yaml/.yml files -
        the browser exists to find a monitor.yaml, not to expose the disk.
        """
        raw = (query.get("path") or [""])[0]
        want = (query.get("kind") or ["any"])[0]

        if not raw:
            return self.send_json({
                "path": "", "parent": "", "crumbs": [],
                "dirs": browse_places(), "files": [], "atRoot": True,
            })

        try:
            path = os.path.abspath(os.path.expandvars(os.path.expanduser(raw)))
        except Exception:
            return self.send_error_json(400, "bad path")
        if not os.path.isdir(path):
            return self.send_error_json(404, "no such folder: %s" % raw)

        dirs, files = [], []
        sniffed = 0
        try:
            entries = sorted(os.listdir(path), key=lambda n: n.lower())
        except OSError as exc:
            return self.send_error_json(403, "cannot read that folder: %s" % exc)

        for name in entries:
            if name.startswith("."):
                continue
            full = os.path.join(path, name)
            try:
                if os.path.isdir(full):
                    dirs.append({"name": name, "path": full})
                elif name.lower().endswith((".yaml", ".yml")):
                    kind = "yaml"
                    # sniffing costs a read, so only do it for a sane number
                    if sniffed < 80:
                        sniffed += 1
                        kind = sniff_kind(full)
                    # Every YAML is listed. Filtering by kind hid files whose
                    # contents did not match what the sniffer expected - the
                    # picker highlights likely matches instead of deciding for
                    # you which of your own files you are allowed to choose.
                    files.append({"name": name, "path": full, "kind": kind,
                                  "mtime": int(os.path.getmtime(full) * 1000)})
            except OSError:
                continue   # a permission wall mid-listing is not fatal

        parent = os.path.dirname(path)
        if parent == path or not parent:
            parent = ""   # already at a drive root or /

        return self.send_json({
            "path": path, "parent": parent, "crumbs": browse_crumbs(path),
            "dirs": dirs, "files": files, "atRoot": False,
        })

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_file(self, path, content_type=None):
        if not os.path.isfile(path):
            self.send_error_json(404, "not found: %s" % os.path.basename(path))
            return
        ctype = content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        route = posixpath.normpath(unquote(parsed.path))
        query = parse_qs(parsed.query)

        try:
            if route.startswith("/api/"):
                return self.handle_api_get(route, query)
            if route in ("/", "/index.html"):
                return self.send_file(os.path.join(path_for("web"), "index.html"))
            if route.startswith("/shapes/"):
                return self.send_file(path_for("shapes", route[len("/shapes/"):]))
            if route.startswith("/backgrounds/"):
                return self.send_file(path_for("backgrounds", route[len("/backgrounds/"):]))
            rel = route.lstrip("/")
            if ".." in rel.split("/"):
                return self.send_error_json(400, "bad path")
            return self.send_file(os.path.join(path_for("web"), *rel.split("/")))
        except ValueError as exc:
            return self.send_error_json(400, str(exc))
        except Exception as exc:  # surfaced to the UI rather than killing the server
            return self.send_error_json(500, "%s: %s" % (type(exc).__name__, exc))

    def do_POST(self):
        parsed = urlparse(self.path)
        route = posixpath.normpath(unquote(parsed.path))
        try:
            if route.startswith("/api/"):
                return self.handle_api_post(route)
            return self.send_error_json(404, "no such endpoint")
        except ValueError as exc:
            return self.send_error_json(400, str(exc))
        except Exception as exc:
            return self.send_error_json(500, "%s: %s" % (type(exc).__name__, exc))

    # -- API --------------------------------------------------------------

    def handle_api_get(self, route, query):
        if route == "/api/hello":
            CLIENT["last"] = time.time()
            CLIENT["seen"] = True
            CLIENT["deadline"] = 0.0
            # server.py is read once at startup, so a file newer than the
            # process is code this server is not running. Saying so beats the
            # confusing "no such endpoint" you get from a route added since.
            try:
                src = os.path.getmtime(os.path.abspath(__file__))
            except OSError:
                src = 0
            return self.send_json({
                "ok": True,
                "root": ROOT,
                "dirs": dict((k, os.path.join(ROOT, v)) for k, v in DIRS.items()),
                "startedAt": int(STARTED_AT * 1000),
                "sourceMtime": int(src * 1000),
                "stale": bool(src and src > STARTED_AT + 1),
            })

        if route == "/api/ping":
            CLIENT["last"] = time.time()
            CLIENT["seen"] = True
            CLIENT["deadline"] = 0.0
            return self.send_json({"ok": True})

        if route == "/api/bye":
            # A reload fires this too, so do not exit here - just shorten the
            # fuse. A page coming back beats again well inside the grace period.
            CLIENT["deadline"] = time.time() + BYE_GRACE
            return self.send_json({"ok": True})

        if route == "/api/config":
            info = dict(CONFIG)
            info["machineShowsDir"] = ""
            info["machineOk"] = False
            if CONFIG.get("machineFolder"):
                try:
                    info["machineShowsDir"] = machine_shows_dir()
                    info["machineOk"] = True
                except ValueError as exc:
                    info["machineMessage"] = str(exc)
            info["exportsDir"] = path_for("exports")
            return self.send_json(info)

        if route == "/api/folders":
            remembered = [describe_folder(p) for p in CONFIG.get("folders", [])]
            known = set(os.path.normcase(e["path"]) for e in remembered)
            discovered = [describe_folder(p) for p in discover_machines()
                          if os.path.normcase(p) not in known]
            return self.send_json({
                "exportsDir": path_for("exports"),
                "current": CONFIG.get("machineFolder", ""),
                "target": CONFIG.get("exportTarget", "exports"),
                "folders": remembered,
                "discovered": discovered,
            })

        if route == "/api/backgrounds":
            base = path_for("backgrounds")
            names = []
            if os.path.isdir(base):
                names = sorted(n for n in os.listdir(base)
                               if n.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")))
            return self.send_json({"backgrounds": names})

        if route == "/api/shapes":
            base = path_for("shapes")
            names = []
            if os.path.isdir(base):
                names = sorted(
                    n for n in os.listdir(base)
                    if n.lower().endswith((".png", ".gif", ".jpg", ".jpeg", ".webp"))
                )
            return self.send_json({"shapes": names})

        if route == "/api/lightmaps":
            base = path_for("lightmaps")
            names = []
            if os.path.isdir(base):
                for n in sorted(os.listdir(base)):
                    if n.lower().endswith((".yaml", ".yml")) and looks_like_lightmap(os.path.join(base, n)):
                        names.append(n)
            return self.send_json({"lightmaps": names,
                                   "external": prune_external("recentMaps")})

        if route == "/api/lightmap":
            name = (query.get("name") or [""])[0]
            if not name:
                return self.send_error_json(400, "name required")
            try:
                path = lightmap_path(name)
            except ValueError as exc:
                return self.send_error_json(400, str(exc))
            if not os.path.isfile(path):
                return self.send_error_json(404, "no such light map: %s" % name)
            if os.path.isabs(name):
                remember_external("recentMaps", path)
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lights = parse_lightmap(fh.read())

            # tags come from a paired lights.yaml, picked explicitly or by stem
            requested = (query.get("tags") or [None])[0]
            tag_file = requested if requested else find_tag_file(name)
            tag_map = load_tags(tag_file) if tag_file else {}
            if tag_file and os.path.isabs(tag_file):
                remember_external("recentTags", tag_file)
            all_tags = {}
            matched = 0
            for light in lights:
                t = tag_map.get(light["name"], [])
                light["tags"] = t
                if t:
                    matched += 1
                for tag in t:
                    all_tags[tag] = all_tags.get(tag, 0) + 1

            return self.send_json({
                "name": name,
                "lights": lights,
                "mtime": file_mtime("lightmaps", name),
                "tagMtime": file_mtime("lightmaps", tag_file) if tag_file else 0,
                "tagFile": tag_file or "",
                "tags": [{"tag": k, "count": v} for k, v in
                         sorted(all_tags.items(), key=lambda kv: (-kv[1], kv[0]))],
                "taggedLights": matched,
                "untaggedInFile": sorted(set(tag_map) - set(l["name"] for l in lights)),
            })

        if route == "/api/lightmap-stat":
            # Cheap freshness probe: just the timestamps, no parsing.
            name = (query.get("name") or [""])[0]
            tags = (query.get("tags") or [""])[0]
            return self.send_json({
                "name": name,
                "mtime": file_mtime("lightmaps", name) if name else 0,
                "tagMtime": file_mtime("lightmaps", tags) if tags else 0,
            })

        if route == "/api/tagfiles":
            base = path_for("lightmaps")
            names = []
            if os.path.isdir(base):
                for n in sorted(os.listdir(base)):
                    if n.lower().endswith((".yaml", ".yml")) and looks_like_tagfile(os.path.join(base, n)):
                        names.append(n)
            return self.send_json({"tagfiles": names,
                                   "external": prune_external("recentTags")})

        if route == "/api/browse":
            return self.handle_browse(query)

        if route == "/api/shows":
            base = path_for("shows")
            names = sorted(n for n in os.listdir(base) if n.endswith(".json")) if os.path.isdir(base) else []
            return self.send_json({"shows": names})

        if route == "/api/show":
            name = (query.get("name") or [""])[0]
            if not name:
                return self.send_error_json(400, "name required")
            path = path_for("shows", name)
            if not os.path.isfile(path):
                return self.send_error_json(404, "no such show: %s" % name)
            with open(path, "r", encoding="utf-8") as fh:
                return self.send_json({"name": name, "project": json.load(fh)})

        if route == "/api/showfiles":
            return self.send_json({"files": list_show_files()})

        if route == "/api/showfile":
            source = (query.get("source") or ["imports"])[0]
            name = (query.get("name") or [""])[0]
            if not name:
                return self.send_error_json(400, "name required")
            full = resolve_show_file(source, name)
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                parsed = parse_mpf_show(fh.read())
            parsed["name"] = name
            parsed["source"] = source
            best, pos = best_map_for(parsed["lightNames"])
            parsed["positionMap"] = best or ""
            parsed["positions"] = pos
            return self.send_json(parsed)

        if route == "/api/exports":
            base = path_for("exports")
            names = sorted(n for n in os.listdir(base) if n.endswith((".yaml", ".yml"))) if os.path.isdir(base) else []
            return self.send_json({"exports": names})

        return self.send_error_json(404, "no such endpoint: %s" % route)

    def handle_api_post(self, route):
        body = self.read_json_body()

        if route == "/api/config":
            if "machineFolder" in body:
                folder = str(body.get("machineFolder", "")).strip()
                if folder:
                    # fail loudly rather than remembering a path that will not work
                    machine_shows_dir(folder)
                CONFIG["machineFolder"] = folder
            for key in ("lightMap", "tagFile", "exportTarget", "background"):
                if key in body:
                    CONFIG[key] = str(body.get(key, "")).strip()
            save_config()
            info = dict(CONFIG)
            info["machineShowsDir"] = ""
            info["machineOk"] = False
            if CONFIG.get("machineFolder"):
                try:
                    info["machineShowsDir"] = machine_shows_dir()
                    info["machineOk"] = True
                except ValueError:
                    pass
            return self.send_json(info)

        if route == "/api/folders":
            add = str(body.get("add", "")).strip()
            remove = str(body.get("remove", "")).strip()
            folders = list(CONFIG.get("folders", []))
            if add:
                # fail loudly rather than remembering a path that will not work
                machine_shows_dir(add)
                resolved = os.path.abspath(os.path.expandvars(os.path.expanduser(add)))
                if not any(os.path.normcase(f) == os.path.normcase(resolved) for f in folders):
                    folders.append(resolved)
                CONFIG["machineFolder"] = resolved
                CONFIG["exportTarget"] = "machine"
            if remove:
                folders = [f for f in folders
                           if os.path.normcase(f) != os.path.normcase(remove)]
                if os.path.normcase(CONFIG.get("machineFolder", "")) == os.path.normcase(remove):
                    CONFIG["machineFolder"] = ""
                    CONFIG["exportTarget"] = "exports"
            CONFIG["folders"] = folders
            save_config()
            return self.send_json({"ok": True, "folders": folders,
                                   "current": CONFIG.get("machineFolder", ""),
                                   "target": CONFIG.get("exportTarget", "exports")})

        if route == "/api/show":
            name = body.get("name") or "untitled"
            if not name.endswith(".json"):
                name += ".json"
            path = path_for("shows", name)
            ensure_dirs()
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(body.get("project", {}), fh, indent=1)
            return self.send_json({"ok": True, "name": name, "path": path})

        if route == "/api/show-delete":
            name = body.get("name") or ""
            path = path_for("shows", name)
            if os.path.isfile(path):
                os.remove(path)
            return self.send_json({"ok": True})

        if route == "/api/export":
            name = body.get("name") or "show.yaml"
            if not name.endswith((".yaml", ".yml")):
                name += ".yaml"
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name: %r" % name)
            content = body.get("content", "")
            target = body.get("target", "exports")

            if target == "machine":
                base = machine_shows_dir(create=True)
            else:
                base = path_for("exports")
                ensure_dirs()

            path = os.path.join(base, name)
            # never escape the intended folder
            if os.path.dirname(os.path.abspath(path)) != os.path.abspath(base):
                return self.send_error_json(400, "refusing to write outside %s" % base)

            existed = os.path.isfile(path)
            if existed and not body.get("overwrite"):
                return self.send_json({"ok": False, "exists": True, "path": path})

            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            return self.send_json({"ok": True, "name": name, "path": path,
                                   "replaced": existed, "target": target,
                                   "bytes": len(content.encode("utf-8"))})

        if route == "/api/lightmap-import":
            name = body.get("name") or "imported.yaml"
            if not name.endswith((".yaml", ".yml")):
                name += ".yaml"
            text = body.get("content", "")
            lights = parse_lightmap(text)
            if not lights:
                return self.send_error_json(400, "no lights found in that file")
            path = path_for("lightmaps", name)
            ensure_dirs()
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            return self.send_json({"ok": True, "name": name, "lights": lights})

        if route == "/api/background-import":
            name = body.get("name") or "playfield.png"
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name: %r" % name)
            if not name.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                return self.send_error_json(400, "expected an image file")
            data = body.get("content", "")
            if "," in data[:64]:
                data = data.split(",", 1)[1]          # strip a data: URL prefix
            try:
                raw = base64.b64decode(data)
            except Exception:
                return self.send_error_json(400, "could not decode that image")
            if len(raw) > 20 * 1024 * 1024:
                return self.send_error_json(400, "image is larger than 20 MB")
            ensure_dirs()
            with open(path_for("backgrounds", name), "wb") as fh:
                fh.write(raw)
            return self.send_json({"ok": True, "name": name, "bytes": len(raw)})

        if route == "/api/tagfile-import":
            name = body.get("name") or "lights.yaml"
            if not name.endswith((".yaml", ".yml")):
                name += ".yaml"
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name: %r" % name)
            text = body.get("content", "")
            tags = parse_light_tags(text)
            if not tags:
                return self.send_error_json(400, "no lights with tags found in that file")
            ensure_dirs()
            with open(path_for("lightmaps", name), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            return self.send_json({"ok": True, "name": name, "lights": len(tags)})

        if route == "/api/showfile-import":
            name = body.get("name") or "imported_show.yaml"
            if not name.endswith((".yaml", ".yml")):
                name += ".yaml"
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name: %r" % name)
            text = body.get("content", "")
            parsed = parse_mpf_show(text)
            if not parsed["steps"]:
                return self.send_error_json(400, "no show steps found in that file")
            ensure_dirs()
            with open(path_for("imports", name), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            parsed["name"] = name
            parsed["source"] = "imports"
            best, pos = best_map_for(parsed["lightNames"])
            parsed["positionMap"] = best or ""
            parsed["positions"] = pos
            return self.send_json(parsed)

        return self.send_error_json(404, "no such endpoint: %s" % route)


def watch_client(httpd, keep_alive):
    """Shut the server down once the page that was using it has gone."""
    if keep_alive:
        return
    while True:
        time.sleep(2.0)
        now = time.time()
        if not CLIENT["seen"]:
            # nobody has ever connected; wait rather than quitting on startup
            if now - STARTED_AT > 90:
                print("\nno page connected; exiting")
                break
            continue
        if CLIENT["deadline"] and now > CLIENT["deadline"]:
            print("\nwindow closed; exiting")
            break
        if now - CLIENT["last"] > IDLE_TIMEOUT:
            print("\nwindow gone; exiting")
            break
    threading.Thread(target=httpd.shutdown, daemon=True).start()


def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Pinlandia Show Creator")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--root", default=HERE, help="folder holding web/ shapes/ lightmaps/ ...")
    ap.add_argument("--machine", default=None, help="MPF machine folder to export into")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--keep-alive", action="store_true",
                    help="stay running after the browser window closes")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    ROOT = os.path.abspath(args.root)
    Handler.verbose = args.verbose
    ensure_dirs()
    load_config()
    if args.machine:
        CONFIG["machineFolder"] = args.machine
        save_config()

    port = args.port
    httpd = None
    for _ in range(20):
        try:
            httpd = HTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print("Could not bind a port in %d..%d" % (args.port, port))
        return 1

    url = "http://127.0.0.1:%d/" % port
    print("Pinlandia Show Creator")
    print("  serving %s" % ROOT)
    if CONFIG.get("machineFolder"):
        try:
            print("  machine %s" % machine_shows_dir())
        except ValueError as exc:
            print("  machine INVALID: %s" % exc)
    print("  open    %s" % url)
    print("  stop    Ctrl-C%s" % ("" if args.keep_alive else ", or just close the window"))
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    threading.Thread(target=watch_client, args=(httpd, args.keep_alive), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
