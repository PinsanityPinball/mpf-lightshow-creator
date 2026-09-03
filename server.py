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
    effects/    saved reusable effects (.json)
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
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

HERE = os.path.dirname(os.path.abspath(__file__))

DIRS = {
    "web": "web",
    "shapes": "shapes",
    "lightmaps": "lightmaps",
    "shows": "shows",
    "imports": "imports",
    "exports": "exports",
    "backgrounds": "backgrounds",
    "effects": "effects",
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


def _effect_colour(layers):
    """A representative colour, for the swatch in the effects browser."""
    for l in layers:
        if l.get("kind") == "pattern":
            p = l.get("pattern") or {}
            if p.get("colors"):
                return p["colors"][0]
            if p.get("color"):
                return p["color"]
        for k in l.get("keys") or []:
            if k.get("color"):
                return k["color"]
    return "#4fc3f7"


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
    """Guess the lights.yaml that goes with a monitor.yaml, by stem."""
    base = path_for("lightmaps")
    stem = re.sub(r"\.(yaml|yml)$", "", lightmap_name, flags=re.I)
    stem = re.sub(r"(^|[_-])monitor([_-]|$)", r"\1", stem, flags=re.I).strip("_-")
    candidates = []
    if stem:
        candidates += ["%s_lights.yaml" % stem, "lights_%s.yaml" % stem, "%s.lights.yaml" % stem]
    candidates.append("lights.yaml")
    for name in candidates:
        full = os.path.join(base, name)
        if os.path.isfile(full):
            return name
    return None


def file_mtime(kind, name):
    """Modification time of a file, or 0 when it is not there."""
    if not name:
        return 0
    try:
        return int(os.path.getmtime(path_for(kind, name)) * 1000)
    except (OSError, ValueError):
        return 0


def load_tags(name):
    if not name:
        return {}
    full = path_for("lightmaps", name)
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
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(4096)
    except OSError:
        return False
    return re.search(r"^(light|lights|leds):\s*$", head, re.M) is not None


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
            return self.send_json({
                "ok": True,
                "root": ROOT,
                "dirs": dict((k, os.path.join(ROOT, v)) for k, v in DIRS.items()),
            })

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
            return self.send_json({"lightmaps": names})

        if route == "/api/lightmap":
            name = (query.get("name") or [""])[0]
            if not name:
                return self.send_error_json(400, "name required")
            path = path_for("lightmaps", name)
            if not os.path.isfile(path):
                return self.send_error_json(404, "no such light map: %s" % name)
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lights = parse_lightmap(fh.read())

            # tags come from a paired lights.yaml, picked explicitly or by stem
            requested = (query.get("tags") or [None])[0]
            tag_file = requested if requested else find_tag_file(name)
            tag_map = load_tags(tag_file) if tag_file else {}
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
            return self.send_json({"tagfiles": names})

        if route == "/api/effects":
            base = path_for("effects")
            out = []
            if os.path.isdir(base):
                for n in sorted(os.listdir(base)):
                    if not n.endswith(".json"):
                        continue
                    try:
                        with open(os.path.join(base, n), "r", encoding="utf-8") as fh:
                            d = json.load(fh)
                    except (OSError, ValueError):
                        continue
                    layers = d.get("layers", [])
                    tags = set()
                    for l in layers:
                        t = l.get("target") or {}
                        tags.update(t.get("tags") or [])
                    out.append({
                        "file": n,
                        "name": d.get("name", n[:-5]),
                        "group": d.get("group", "Saved"),
                        "layers": len(layers),
                        "kinds": sorted(set(l.get("kind", "shape") for l in layers)),
                        "shapeId": layers[0].get("shapeId") if layers else None,
                        "shapeParams": layers[0].get("shapeParams") if layers else None,
                        "patternType": ((layers[0].get("pattern") or {}).get("type")
                                        if layers and layers[0].get("kind") == "pattern" else None),
                        "colour": _effect_colour(layers),
                        "durationMs": d.get("durationMs", 0),
                        "lightMap": d.get("lightMap", ""),
                        "tags": sorted(tags),
                        "created": d.get("created", ""),
                    })
            return self.send_json({"effects": out})

        if route == "/api/effect":
            name = (query.get("name") or [""])[0]
            if not name:
                return self.send_error_json(400, "name required")
            path = path_for("effects", name)
            if not os.path.isfile(path):
                return self.send_error_json(404, "no such effect: %s" % name)
            with open(path, "r", encoding="utf-8") as fh:
                return self.send_json({"name": name, "effect": json.load(fh)})

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

        if route == "/api/effect":
            name = body.get("name") or "effect"
            if not name.endswith(".json"):
                name += ".json"
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name: %r" % name)
            effect = body.get("effect") or {}
            if not effect.get("layers"):
                return self.send_error_json(400, "an effect needs at least one layer")
            ensure_dirs()
            path = path_for("effects", name)
            existed = os.path.isfile(path)
            if existed and not body.get("overwrite"):
                return self.send_json({"ok": False, "exists": True, "name": name})
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(effect, fh, indent=1)
            return self.send_json({"ok": True, "name": name, "replaced": existed})

        if route == "/api/effect-delete":
            name = body.get("name") or ""
            if not SAFE_NAME.match(name):
                return self.send_error_json(400, "unsafe name")
            path = path_for("effects", name)
            if os.path.isfile(path):
                os.remove(path)
            return self.send_json({"ok": True})

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


def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Pinlandia Show Creator")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--root", default=HERE, help="folder holding web/ shapes/ lightmaps/ ...")
    ap.add_argument("--machine", default=None, help="MPF machine folder to export into")
    ap.add_argument("--no-browser", action="store_true")
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
    print("  stop    Ctrl-C")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
