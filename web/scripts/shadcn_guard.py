"""shadcn-only UI guard. Usage: python3 -I shadcn_guard.py {check|context}  (hook payload on stdin)

check    PreToolUse hook for Write|Edit|MultiEdit. Denies the edit when the text it adds to a
         .jsx/.tsx file uses a native element that has a shadcn component (<button>, <input>,
         <select>, ...) or imports another UI kit / raw primitive library. Files inside the
         project's shadcn ui directory (components.json aliases.ui, default components/ui) are
         exempt: that is where shadcn's own source lives and may be customised.
         Only added text is checked, so existing code never blocks an unrelated edit.
context  SessionStart hook. In a React project (components.json, or react in package.json)
         adds the shadcn-only rule to the session context.
"""
import json
import os
import re
import sys

JSX_EXT = (".tsx", ".jsx")

# native tag -> shadcn replacement
NATIVE = {
    "button": "Button (`npx shadcn@latest add button`)",
    "input": "Input, or Checkbox / RadioGroup / Switch / Slider for those input types",
    "select": "Select or NativeSelect",
    "textarea": "Textarea",
    "dialog": "Dialog, AlertDialog, Sheet or Drawer",
    "table": "Table (or the Data Table pattern)",
    "progress": "Progress",
    "meter": "Progress",
    "details": "Accordion or Collapsible",
    "hr": "Separator",
    "label": "Label (or Field / FieldLabel)",
}
NATIVE_RE = re.compile(r"<(" + "|".join(NATIVE) + r")(?=[\s/>])")
HIDDEN_INPUT_RE = re.compile(r"<input\b[^>]*\btype\s*=\s*[{]?\s*[\"']hidden[\"']")

OTHER_KITS = (
    "@mui/", "@material-ui/", "antd", "@chakra-ui/", "react-bootstrap", "@mantine/",
    "@headlessui/", "@nextui-org/", "@heroui/", "semantic-ui-react", "primereact",
    "@ark-ui/", "react-aria-components", "@fluentui/", "@blueprintjs/", "daisyui",
)
# Primitive libraries shadcn wraps: fine inside the ui dir, not elsewhere.
PRIMITIVES = ("@radix-ui/", "radix-ui", "@base-ui-components/", "@base-ui/")
IMPORT_RE = re.compile(r"""(?:from\s+|import\s*\(?\s*|require\(\s*)["']([^"']+)["']""")


def find_up(start, name):
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, name)):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def ui_dirs(root):
    """Directories (relative to root) that hold shadcn's own component source."""
    alias = "@/components/ui"
    try:
        with open(os.path.join(root, "components.json")) as f:
            alias = (json.load(f).get("aliases") or {}).get("ui") or alias
    except (OSError, ValueError):
        pass
    seg = re.sub(r"^[@~#]?/", "", alias).strip("/")
    return {seg, "src/" + seg, "components/ui", "src/components/ui"}


def is_ui_file(path):
    root = find_up(os.path.dirname(path), "components.json")
    if root:
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        return any(rel.startswith(d + "/") for d in ui_dirs(root))
    return "/components/ui/" in path.replace(os.sep, "/")


def added_text(tool, inp):
    if tool == "Write":
        return inp.get("content") or ""
    if tool == "Edit":
        return inp.get("new_string") or ""
    if tool == "MultiEdit":
        return "\n".join(e.get("new_string") or "" for e in inp.get("edits") or [])
    return ""


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", text)


def violations(text):
    text = strip_comments(text)
    found = []
    for i, line in enumerate(text.splitlines(), 1):
        for m in NATIVE_RE.finditer(line):
            tag = m.group(1)
            if tag == "input" and HIDDEN_INPUT_RE.match(line, m.start()):
                continue
            found.append(f"line {i}: <{tag}> -> use shadcn {NATIVE[tag]}")
        for mod in IMPORT_RE.findall(line):
            if any(mod == k.rstrip("/") or mod.startswith(k) for k in OTHER_KITS):
                found.append(f"line {i}: import from '{mod}' -> only shadcn/ui components are allowed")
            elif any(mod == k.rstrip("/") or mod.startswith(k) for k in PRIMITIVES):
                found.append(f"line {i}: import from '{mod}' -> import the shadcn wrapper from the ui directory instead")
    return found


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def check(payload):
    inp = payload.get("tool_input") or {}
    path = inp.get("file_path") or ""
    if not path.endswith(JSX_EXT):
        return
    if not os.path.isabs(path):
        path = os.path.join(payload.get("cwd") or os.getcwd(), path)
    if is_ui_file(path):
        return
    found = violations(added_text(payload.get("tool_name"), inp))
    if not found:
        return
    has_cfg = find_up(os.path.dirname(path), "components.json") is not None
    reason = (
        "web plugin: all UI must be built from shadcn/ui components. This edit to "
        f"{os.path.basename(path)} adds:\n  - " + "\n  - ".join(found[:15])
        + ("\n  - ..." if len(found) > 15 else "")
        + "\nAdd the component with `npx shadcn@latest add <name>` (or the shadcn MCP tools) and import it "
        "from the ui directory. To customise a component, edit its file in components/ui instead."
    )
    if not has_cfg:
        reason += "\nNo components.json found: run `npx shadcn@latest init` first."
    deny(reason)


def is_react_project(cwd):
    if os.path.exists(os.path.join(cwd, "components.json")):
        return True
    try:
        with open(os.path.join(cwd, "package.json")) as f:
            pkg = json.load(f)
    except (OSError, ValueError):
        return False
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    return "react" in deps or "next" in deps


def context(payload):
    if not is_react_project(payload.get("cwd") or os.getcwd()):
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": (
            "This project follows a shadcn-only UI rule (web plugin). Build every component from "
            "shadcn/ui: add components with `npx shadcn@latest add <name>` or the shadcn MCP server, "
            "compose them, and customise them in the ui directory. Do not hand-roll native "
            "<button>/<input>/<select>/<textarea>/<dialog>/<table>/<label>/<hr>/<progress>/<details> "
            "elements or import other UI kits or raw Radix/Base UI primitives outside the ui "
            "directory; a hook rejects such edits. Use the shadcn skill for component APIs and the "
            "impeccable skill for design quality."
        ),
    }}))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    (context if mode == "context" else check)(payload)


if __name__ == "__main__":
    main()
