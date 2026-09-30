"""Profile-local context guard for Capiro QA. Never patches shared files on disk."""
import dataclasses, functools, json, os, threading, time
from pathlib import Path
LOCK = threading.Lock()
ROOT = Path(r'C:\dev\capiro-qa-evidence')

def qa_worker_scope():
    # Native dispatch pins HERMES_KANBAN_DB, not necessarily BOARD. Children
    # inherit this scope; never rely only on the optional human slug.
    board = os.environ.get('HERMES_KANBAN_BOARD') == 'capiro-qa'
    db = os.environ.get('HERMES_KANBAN_DB', '').replace('\\', '/').lower()
    expected = 'c:/programdata/hermes/kanban/boards/capiro-qa/kanban.db'
    return bool(os.environ.get('HERMES_KANBAN_TASK')) and (board or db == expected)

def decision(window, pressure, reserve, byte_bound):
    return window > 0 and pressure + reserve < int(window * .40) and byte_bound + reserve < int(window * .48)

def install_surfaces():
    import agent.tool_executor as executor
    from tools.budget_config import BudgetConfig
    # Retain full tool outputs on disk while passing short previews to the model.
    # This prevents parallel file reads from inflating the next request.
    executor._budget_for_agent = lambda agent: BudgetConfig(default_result_size=4000, turn_budget=12000, preview_size=1000, mcp_result_size=4000, tool_overrides={'kanban_show':8000})
    # Keep the original authorization handler; avoid duplicating the body in
    # worker_context and replaying historical failures into every fresh run.
    import tools.kanban_tools
    from tools.registry import registry
    entry = registry.get_entry('kanban_show')
    if entry and not getattr(entry.handler, '_capiro_compact', False):
        show = entry.handler
        @functools.wraps(show)
        def compact_show(*args, **kwargs):
            raw = show(*args, **kwargs)
            if not qa_worker_scope(): return raw
            try: value = json.loads(raw)
            except (TypeError, ValueError): return raw
            if not isinstance(value,dict) or 'task' not in value: return raw
            task = value['task']
            keys = ('id','title','body','status','workspace_path','model_override','provider_override','last_failure_error')
            return json.dumps({'task':{k:task.get(k) for k in keys},'unsatisfied_parents':value.get('unsatisfied_parents',[]),'history':'Retained on board; current brief defines the bounded continuation. Read CLI logs only if assigned.'},ensure_ascii=False)
        compact_show._capiro_compact = True
        entry.handler = compact_show
    import model_tools
    if not getattr(model_tools._select_tool_names, '_capiro_lean', False):
        select = model_tools._select_tool_names
        @functools.wraps(select)
        def lean_select(*args, **kwargs):
            names = select(*args, **kwargs)
            if qa_worker_scope():
                lifecycle = {'kanban_show', 'kanban_comment', 'kanban_block', 'kanban_request_review', 'kanban_heartbeat'}
                names = {n for n in names if not n.startswith('kanban_') or n in lifecycle}
            return names
        lean_select._capiro_lean = True
        model_tools._select_tool_names = lean_select
    # Tool search may expose a deferred tool after selection. Fence its actual
    # handler as well, preserving the original handler for all other boards.
    for name in [item.name for item in registry._snapshot_entries()]:
        if not name.startswith('kanban_') or name in {'kanban_show','kanban_comment','kanban_block','kanban_request_review','kanban_heartbeat'}: continue
        forbidden = registry.get_entry(name)
        if not forbidden or getattr(forbidden.handler, '_capiro_parent_only', False): continue
        original_handler = forbidden.handler
        @functools.wraps(original_handler)
        def parent_only(*args, _handler=original_handler, **kwargs):
            if qa_worker_scope():
                return json.dumps({'error':'Capiro QA workers may request Review only; parent independently verifies and completes. No mutation performed.'})
            return _handler(*args, **kwargs)
        parent_only._capiro_parent_only=True
        forbidden.handler=parent_only

def install():
    # Install only the preflight gate during plugin loading. Tool discovery
    # runs lazily on the main request thread after plugin discovery releases.
    import agent.turn_preflight_gate as gate
    import agent.conversation_loop as loop
    from agent.turn_preflight import PreflightGateVerdict
    if getattr(gate.run_preflight_gate, '_capiro_guard', False): return
    original = gate.run_preflight_gate
    @functools.wraps(original)
    def guarded(agent, **kwargs):
        install_surfaces()
        if qa_worker_scope():
            lifecycle={"kanban_show","kanban_comment","kanban_block","kanban_request_review","kanban_heartbeat"}
            agent.tools=[t for t in agent.tools if not (t.get("function",t).get("name","").startswith("kanban_") and t.get("function",t).get("name") not in lifecycle)]
        window = int(agent.context_compressor.context_length or 0)
        pressure = int(kwargs['request_pressure_tokens'])
        reserve = int(agent.max_tokens or 4096)
        # UTF-8 serialized request surfaces form a conservative text byte bound.
        # No screenshots in model context: vision reviews use the dedicated image path.
        messages = kwargs.get('messages') or []
        system = kwargs.get('active_system_prompt') or kwargs.get('system_message') or ''
        # Count the system once; messages may already hold its role entry.
        messages = [m for m in messages if not isinstance(m, dict) or m.get('role') != 'system']
        payload = {'messages': messages, 'system': system, 'tools': getattr(agent, 'tools', [])}
        byte_bound = len(json.dumps(payload, ensure_ascii=False, default=str).encode('utf-8'))
        allowed = decision(window, pressure, reserve, byte_bound)
        row = {'time': time.time(), 'session_id': agent.session_id, 'model': agent.model, 'provider': agent.provider, 'window': window, 'pressure': pressure, 'output_reserve': reserve, 'text_byte_bound': byte_bound, 'fraction_with_reserve': (pressure+reserve)/window if window else None, 'allowed': allowed}
        with LOCK:
            out = ROOT / 'context' / (str(agent.session_id or os.getpid()) + '.jsonl')
            out.parent.mkdir(parents=True, exist_ok=True)
            with out.open('a', encoding='utf-8') as f: f.write(json.dumps(row)+'\n')
        if allowed: return original(agent, **kwargs)
        fields = {f.name for f in dataclasses.fields(PreflightGateVerdict)}
        values = {k:v for k,v in kwargs.items() if k in fields}
        values.update(action='break', final_response='BLOCKED: context guard; preserve artifact checkpoint and continue in a fresh session. No request sent at the guard boundary.', failed=True, _turn_exit_reason='capiro_qa_context_guard')
        return PreflightGateVerdict(**values)
    guarded._capiro_guard = True
    gate.run_preflight_gate = guarded
    loop.run_preflight_gate = guarded

def register(ctx):
    install()
