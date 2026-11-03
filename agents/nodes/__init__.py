"""Registry of agent nodes. Each module exposes run(state, ctx) -> dict."""
from importlib import import_module

from ..state import AGENT_IDS

REGISTRY = {aid: import_module(f".{aid}", __name__).run for aid in AGENT_IDS}
