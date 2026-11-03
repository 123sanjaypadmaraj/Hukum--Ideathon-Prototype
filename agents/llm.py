"""LLM access for the HUKUM agent team.

get_llm() returns GroqLLM when GROQ_API_KEY is set and HUKUM_OFFLINE != "1",
otherwise the deterministic OfflineLLM. Both expose think / choose / json with
identical signatures. GroqLLM never raises: every failure returns the fallback.
"""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any

from .ctx import OfflineLLM

_ENV_LOADED = False
_THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)


def load_env(path: str | os.PathLike | None = None) -> None:
    """Minimal KEY=VALUE loader for agents/.env. Existing env vars win."""
    global _ENV_LOADED
    if _ENV_LOADED and path is None:
        return
    p = Path(path) if path else Path(__file__).with_name(".env")
    _ENV_LOADED = True
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().removeprefix("export ").strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if k and k not in os.environ:
            os.environ[k] = v


def _clean(text: Any) -> str:
    if not isinstance(text, str):
        text = str(text or "")
    text = _THINK_RE.sub("", text)
    if "</think>" in text:  # unclosed opening tag swallowed by the model
        text = text.split("</think>", 1)[1]
    # gpt-oss likes narrow no-break spaces, fancy dashes and markdown bold; keep the UI plain
    for a, b in ((" ", " "), (" ", " "), ("‑", "-"), ("–", "-"), ("—", " - "),
                 ("‘", "'"), ("’", "'"), ("“", '"'), ("”", '"'), ("≈", "~"), ("**", "")):
        text = text.replace(a, b)
    return text.strip()


def _first_json_object(text: str) -> dict | None:
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except ValueError:
                        pass
                    break
        start = text.find("{", start + 1)
    return None


_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="groq")


class SlowModel(Exception):
    """Raised when a call would exceed the per-call timeout or the run budget."""


_NUM_RE = re.compile(r"(?<![\w.])-?\d[\d,]*(?:\.\d+)?")


def _numbers(obj: Any, out: list[float]) -> list[float]:
    """Every number in a payload, including numbers written inside strings."""
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, str):
        for m in _NUM_RE.findall(obj):
            try:
                out.append(float(m.replace(",", "")))
            except ValueError:
                pass
    elif isinstance(obj, dict):
        for v in obj.values():
            _numbers(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _numbers(v, out)
    return out


def grounded(text: str, *sources: Any) -> bool:
    """True when every number the model wrote appears in the data (allowing rounding,
    lakh/crore-free unit scaling of x100 for fractions shown as percentages)."""
    known: list[float] = []
    for s in sources:
        _numbers(s, known)
    for m in _NUM_RE.findall(text):
        try:
            v = abs(float(m.replace(",", "")))
        except ValueError:
            continue
        if v <= 12 or (1900 <= v <= 2100 and v == int(v)):
            continue  # small counts, hours, years
        ok = False
        for k in known:
            for kk in (abs(k), abs(k) * 100):
                if kk and abs(v - kk) <= max(0.051, 0.012 * kk):
                    ok = True
                    break
            if ok:
                break
        if not ok:
            return False
    return True


class GroqLLM:
    """Groq-hosted chat model with the OfflineLLM interface and safe fallbacks.

    Speed guard: a call slower than HUKUM_LLM_TIMEOUT seconds (default 6) is
    abandoned and the scripted fallback is used; once a run has spent
    HUKUM_LLM_BUDGET seconds (default 45) waiting on the model, or after 3
    failures in a row, every remaining call is simulated instantly. The numbers
    never depend on the model, so the demo stays fast and correct.
    """

    def __init__(self, model: str | None = None):
        self.model = model or os.getenv("HUKUM_MODEL", "openai/gpt-oss-120b")
        self.name = f"groq:{self.model}"
        self.last_error: str = ""
        self.timeout = float(os.getenv("HUKUM_LLM_TIMEOUT", "6") or 6)
        self.budget = float(os.getenv("HUKUM_LLM_BUDGET", "45") or 45)
        self.max_chars = int(os.getenv("HUKUM_LLM_MAX_CHARS", "2500") or 2500)
        self.backup = os.getenv("HUKUM_MODEL_BACKUP", "openai/gpt-oss-20b")
        self.spent = 0.0
        self.fails_in_row = 0
        self.calls = 0
        self.simulated = 0
        self._chat = None

    def _client(self):
        if self._chat is None:
            from langchain_groq import ChatGroq
            kw = dict(model=self.model, temperature=0.2, timeout=self.timeout + 2, max_retries=0, max_tokens=700)
            if "gpt-oss" in self.model:
                try:
                    self._chat = ChatGroq(reasoning_effort="low", **kw)
                except Exception:  # noqa: BLE001  older langchain-groq without the field
                    self._chat = None
            if self._chat is None:
                self._chat = ChatGroq(**kw)
        return self._chat

    def _ask(self, system: str, payload: Any) -> str:
        if self.spent >= self.budget or self.fails_in_row >= 3:
            self.simulated += 1
            raise SlowModel("model budget used up; simulating")
        from langchain_core.messages import HumanMessage, SystemMessage
        # Small payloads keep us inside Groq's free-tier tokens-per-minute limit.
        human = payload if isinstance(payload, str) else json.dumps(payload, default=str, separators=(",", ":"))
        human = human[:self.max_chars]
        msgs = [SystemMessage(content=system), HumanMessage(content=human)]
        t0 = time.time()
        fut = _POOL.submit(self._client().invoke, msgs)
        try:
            out = fut.result(timeout=self.timeout)
        except FutureTimeout:
            self.fails_in_row += 1
            self.simulated += 1
            raise SlowModel(f"model slower than {self.timeout:g} s; simulating") from None
        except Exception as e:
            self.fails_in_row += 1
            # Rate limited: move to the backup model (its own quota) for the rest of the run.
            if "429" in str(e) or "rate limit" in str(e).lower():
                if self.backup and self.model != self.backup:
                    self.model, self.name, self._chat = self.backup, f"groq:{self.backup}", None
                    self.fails_in_row = 0
            raise
        finally:
            self.spent += time.time() - t0
        self.calls += 1
        self.fails_in_row = 0
        return _clean(getattr(out, "content", out))

    def _fail(self, e: Exception) -> None:
        self.last_error = f"{type(e).__name__}: {str(e)[:160]}"

    def think(self, agent: str, system: str, payload: dict, fallback: str) -> str:
        try:
            sys_p = (f"{system}\nYou are the '{agent}' agent of HUKUM, a campus energy system at NHCE Bengaluru. "
                     "Answer in 1-3 short plain-English sentences, no emojis, no markdown. Use Rs, kWh, kW. "
                     "Only use numbers that appear in the data.")
            text = self._ask(sys_p, payload)
            if not text:
                return fallback
            # Numbers are the tools' job: a sentence with a number not in the data is discarded.
            if not grounded(text, payload, fallback):
                self.last_error = "ungrounded number in model text; used scripted text"
                return fallback
            return text
        except Exception as e:  # noqa: BLE001
            self._fail(e)
            return fallback

    def choose(self, agent: str, question: str, options: list[str], payload: dict, fallback: int = 0) -> int:
        try:
            if not options:
                return fallback
            listing = "\n".join(f"{i + 1}. {o}" for i, o in enumerate(options))
            sys_p = (f"You are the '{agent}' agent of HUKUM (campus energy, NHCE Bengaluru). {question}\n"
                     f"Options:\n{listing}\nReply with the option number only.")
            text = self._ask(sys_p, payload)
            m = re.search(r"\d+", text)
            if not m:
                return fallback
            k = int(m.group()) - 1
            return k if 0 <= k < len(options) else fallback
        except Exception as e:  # noqa: BLE001
            self._fail(e)
            return fallback

    def json(self, agent: str, system: str, payload: dict, fallback: dict) -> dict:
        try:
            sys_p = (f"{system}\nYou are the '{agent}' agent of HUKUM. Reply with a single JSON object only, "
                     f"using these keys: {list(fallback.keys())}.")
            obj = _first_json_object(self._ask(sys_p, payload))
            if obj is None:
                return dict(fallback)
            return {**fallback, **obj}
        except Exception as e:  # noqa: BLE001
            self._fail(e)
            return dict(fallback)


def get_llm(force_offline: bool = False):
    load_env()
    if force_offline or os.getenv("HUKUM_OFFLINE", "0") == "1" or not os.getenv("GROQ_API_KEY"):
        return OfflineLLM()
    try:
        import langchain_groq  # noqa: F401
    except Exception:  # noqa: BLE001
        return OfflineLLM()
    return GroqLLM()
