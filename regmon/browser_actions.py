"""Recorded browser steps for the few portals that hide content behind clicks.

Some regulator portals show the table that matters only after choosing a
report, a period, or a tab. A monitor with ``fetch_mode: "browser"`` can carry
``browser_actions``: a short list of steps replayed in headless Chrome after
the page loads and before it is read, for example

    [{"action": "select", "selector": "#report", "value": "FFIEC 031"},
     {"action": "click", "selector": "button#search"},
     {"action": "wait_for", "selector": "table.results", "seconds": 15}]

Steps are recorded in the reviewer's own browser with the dashboard's recorder
(a bookmarklet that writes this list) or written by hand. They are public-page
interactions only: typing into a password field is refused, a step can never
navigate outside the monitor's scope (every document load is checked by
regmon/browser_fetch.py), and the list is bounded in length and waiting time.

Each step runs as one synchronous script in the page (``ACTION_SCRIPT``), so
the same code is exercised by the real-browser tests whatever drives Chrome.
"""
from __future__ import annotations

import json

ACTIONS = ("click", "type", "select", "check", "uncheck", "press", "scroll", "wait", "wait_for")
MAX_STEPS = 20
MAX_TEXT = 200
MAX_STEP_WAIT = 30
MAX_TOTAL_WAIT = 90
KEYS = ("Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space")


class ActionError(ValueError):
    pass


def _selector(step: dict, where: str, required: bool = True) -> str:
    selector = step.get("selector")
    if selector is None and not required:
        return ""
    if not isinstance(selector, str) or not selector.strip() or len(selector) > MAX_TEXT or any(ch in selector for ch in "\r\n"):
        raise ActionError(f"{where}: selector must be a CSS selector of at most {MAX_TEXT} characters")
    return selector.strip()


def validate_actions(value: object, where: str = "browser_actions") -> list[dict]:
    """The steps in canonical form, or ActionError naming the first problem."""
    if value in (None, []):
        return []
    if not isinstance(value, list):
        raise ActionError(f"{where} must be a list of steps")
    if len(value) > MAX_STEPS:
        raise ActionError(f"{where} has more than {MAX_STEPS} steps")
    steps = []
    total_wait = 0.0
    for index, step in enumerate(value, start=1):
        at = f"{where} step {index}"
        if not isinstance(step, dict):
            raise ActionError(f"{at} must be an object")
        action = step.get("action")
        if action not in ACTIONS:
            raise ActionError(f"{at}: action must be one of {', '.join(ACTIONS)}")
        allowed = {"action", "selector", "note"} | {"type": {"text"}, "select": {"value"}, "press": {"key"}, "wait": {"seconds"},
                                                    "wait_for": {"seconds"}}.get(action, set())
        extra = set(step) - allowed
        if extra:
            raise ActionError(f"{at}: unknown keys for {action}: {', '.join(sorted(extra))}")
        clean: dict = {"action": action}
        if action in {"click", "type", "select", "check", "uncheck", "wait_for"}:
            clean["selector"] = _selector(step, at)
        elif action in {"press", "scroll"}:
            selector = _selector(step, at, required=False)
            if selector:
                clean["selector"] = selector
        if action == "type":
            text = step.get("text")
            if not isinstance(text, str) or len(text) > MAX_TEXT or any(ch in text for ch in "\r\n"):
                raise ActionError(f"{at}: text must be at most {MAX_TEXT} characters on one line")
            clean["text"] = text
        if action == "select":
            option = step.get("value")
            if not isinstance(option, str) or not option or len(option) > MAX_TEXT:
                raise ActionError(f"{at}: value must be the option's value or visible text")
            clean["value"] = option
        if action == "press":
            key = step.get("key", "Enter")
            if key not in KEYS:
                raise ActionError(f"{at}: key must be one of {', '.join(KEYS)}")
            clean["key"] = key
        if action in {"wait", "wait_for"}:
            seconds = step.get("seconds", 10 if action == "wait_for" else 1)
            if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 < seconds <= MAX_STEP_WAIT:
                raise ActionError(f"{at}: seconds must be more than 0 and at most {MAX_STEP_WAIT}")
            clean["seconds"] = seconds
            total_wait += seconds
        note = step.get("note")
        if note is not None:
            if not isinstance(note, str) or len(note) > MAX_TEXT:
                raise ActionError(f"{at}: note must be text of at most {MAX_TEXT} characters")
            clean["note"] = note
        steps.append(clean)
    if total_wait > MAX_TOTAL_WAIT:
        raise ActionError(f"{where} waits {total_wait:g} seconds in total; the limit is {MAX_TOTAL_WAIT}")
    return steps


# One step, run synchronously in the page. Returns "ok", "wait" (a wait_for
# whose element is not there yet) or "error: …". Events are dispatched the way
# a person's input would fire them, so frameworks see the change.
ACTION_SCRIPT = r"""
(step => {
  const find = selector => { try { return document.querySelector(selector); } catch (e) { return undefined; } };
  const el = step.selector ? find(step.selector) : null;
  if (step.selector && el === undefined) return "error: invalid selector " + step.selector;
  const need = () => { if (!el) throw new Error("nothing matches " + step.selector); };
  const fire = (target, type) => target.dispatchEvent(new Event(type, { bubbles: true }));
  try {
    switch (step.action) {
      case "wait_for": return el ? "ok" : "wait";
      case "click": need(); el.scrollIntoView({ block: "center" }); el.click(); return "ok";
      case "type": {
        need();
        if (String(el.type || "").toLowerCase() === "password") return "error: typing into a password field is not allowed";
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(el, step.text); else el.value = step.text;
        fire(el, "input"); fire(el, "change");
        return "ok";
      }
      case "select": {
        need();
        const options = Array.from(el.options || []);
        const wanted = String(step.value);
        const option = options.find(o => o.value === wanted) || options.find(o => (o.textContent || "").trim() === wanted);
        if (!option) return "error: no option " + wanted + " in " + step.selector;
        el.value = option.value; fire(el, "input"); fire(el, "change");
        return "ok";
      }
      case "check": case "uncheck": {
        need();
        const on = step.action === "check";
        if (Boolean(el.checked) !== on) el.click();
        return "ok";
      }
      case "press": {
        const target = el || document.activeElement || document.body;
        const key = step.key || "Enter";
        for (const type of ["keydown", "keypress", "keyup"]) target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
        if (key === "Enter" && target.form) { if (target.form.requestSubmit) target.form.requestSubmit(); else target.form.submit(); }
        return "ok";
      }
      case "scroll": {
        if (el) el.scrollIntoView({ block: "center" }); else window.scrollTo(0, document.documentElement.scrollHeight);
        return "ok";
      }
      case "wait": return "ok";
    }
    return "error: unknown action " + step.action;
  } catch (e) { return "error: " + (e && e.message ? e.message : String(e)); }
})
"""


def step_expression(step: dict) -> str:
    """The JavaScript expression that runs one validated step in the page."""
    return ACTION_SCRIPT.strip() + "(" + json.dumps(step) + ")"


def describe(step: dict) -> str:
    """Plain words for one step, as the dashboard lists them."""
    action = step.get("action")
    target = step.get("selector", "")
    return {
        "click": f"Click {target}", "type": f"Type “{step.get('text', '')}” into {target}", "select": f"Choose “{step.get('value', '')}” in {target}",
        "check": f"Tick {target}", "uncheck": f"Untick {target}", "press": f"Press {step.get('key', 'Enter')}" + (f" in {target}" if target else ""),
        "scroll": f"Scroll to {target}" if target else "Scroll to the bottom", "wait": f"Wait {step.get('seconds', 1)} s",
        "wait_for": f"Wait up to {step.get('seconds', 10)} s for {target}",
    }.get(action, str(action))
