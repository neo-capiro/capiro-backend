# Hermes Agent source evidence — part A

Source: pinned upstream NousResearch/hermes-agent tag `v2026.9.14` (version 0.21.3). Read-only static review; line anchors are relative to the Hermes repo root. "Reachable over POST /v1/runs" refers to the `api_server` gateway platform (gateway/platforms/api_server.py + api_server_runs.py). Facts only.

---

## 1. Native tools inventory and `api_server` default toolset

### Evidence

- `toolsets.py:12-45` — `_HERMES_CORE_TOOLS`: the shared tool list for CLI and all messaging bundles: `web_search, web_extract, terminal, process_manage, read_file, write_file, patch, search_files, vision_analyze, image_generate, skills_list, skill_view, skill_manage, browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_press, browser_get_images, browser_vision, browser_console, browser_cdp, browser_dialog, browser_vault_list, browser_vault_unlock, browser_vault_fill, browser_vault_save_login, browser_vault_enter_code, browser_exec, text_to_speech, todo_list, memory, session_search, clarify, execute_code, delegate_task, cronjob_manage, ha_list_entities, ha_get_state, ha_list_services, ha_call_service, kanban_* (13 tools), computer_use, manage_connections`.
- `toolsets.py:76-160` — atomic toolsets (`TOOLSETS`): `web` [web_search, web_extract]; `search` [web_search]; `x_search`; `vision` [vision_analyze]; `video` [video_analyze]; `image_gen` [image_generate]; `video_gen` [video_generate, xai_video_edit, xai_video_extend]; `computer_use`; `terminal` [terminal, process_manage]; `skills` [skills_list, skill_view, skill_manage]; `browser` (every `browser_*` in core); `cronjob` [cronjob_manage]; `file` [read_file, write_file, patch, search_files]; `tts` [text_to_speech]; `todo` [todo_list]; `memory` [memory]; `context_engine` (runtime-provided); `session_search` [session_search]; `connections` [manage_connections]; `project` [desktop_project]; `bot_room`; `desktop_ui` (GUI-only: read_terminal, close_terminal, desktop_preview, drive_preview, annotate_preview, read_window_below, focus_pane, react_to_message, setup_mcp, gui_tour, show_tip); `clarify` [clarify]; `code_execution` [execute_code]; `delegation` [delegate_task]; `homeassistant` (4 ha_* tools); `kanban` (kanban_*); `discord`, `discord_admin`; `yuanbao`; `feishu_doc`, `feishu_drive`; `spotify` (7 tools); scenario sets `debugging`, `safe`; posture `coding`.
- `toolsets.py:68-70` — `_CODING_TOOLS = _core_without("image_generate", "text_to_speech", "cronjob_manage", "computer_use", *_HA_TOOLS, kanban=False)`.
- `toolsets.py:190-194` — **`hermes-api-server`** composite: `"OpenAI-compatible API server — full agent tools accessible via HTTP (no interactive UI tools like clarify or send_message)"`, tools = `_core_without("text_to_speech", "clarify", "computer_use", kanban=False)`. I.e. core minus `text_to_speech`, `clarify`, `computer_use`, and all `kanban_*`. It KEEPS `terminal`, `process_manage`, file tools, browser tools, `image_generate`, `memory`, `session_search`, `execute_code`, `delegate_task`, `cronjob_manage`, `ha_*`, `manage_connections`, `skills_*`, `todo_list`, `vision_analyze`, web tools.
- `toolsets.py:186-189` — `hermes-acp` = `_CODING_TOOLS` minus `clarify`. `toolsets.py:195` — `hermes-cli` = full bundle.
- `toolsets.py:229-238` — `hermes-webhook` = `["web_search", "web_extract", "vision_analyze", "clarify"]` only (webhook payloads treated as untrusted).
- `hermes_cli/platforms.py:35` — `("api_server", PlatformInfo(label="🌐 API Server", default_toolset="hermes-api-server"))`.
- `hermes_cli/tools_config.py:48` — `PLATFORMS = {k: {"label": ..., "default_toolset": info.default_toolset} ...}` derived from `hermes_cli.platforms.PLATFORMS`.
- `hermes_cli/tools_config.py:172-174` — `_platform_default_toolset(platform)` returns `PLATFORMS[platform]["default_toolset"]` when known, else `f"hermes-{platform}"`.
- `hermes_cli/tools_config.py:96` — `_DEFAULT_OFF_TOOLSETS = {"homeassistant", "spotify", "discord", "discord_admin", "video", "video_gen", "x_search", "a2a", "kanban"}`.
- `hermes_cli/toolset_scope.py:7` — `_TOOLSET_PLATFORM_RESTRICTIONS = {"discord": {"discord"}, "discord_admin": {"discord"}}`.
- `hermes_cli/tools_config.py:471-489` — `_default_off_toolsets(platform, explicitly_configured)`: starts from `_DEFAULT_OFF_TOOLSETS`; removes the platform's own name if listed (not applicable to `api_server`); removes `homeassistant` when `HASS_TOKEN` is configured; with an explicitly saved list, drops platform-restricted entries.
- `hermes_cli/tools_config.py:548-606` — `_get_platform_tools(config, platform)`: if `config["platform_toolsets"][platform]` is not a list, `toolset_names = [_platform_default_toolset(platform)]` (line 557-558); composite path `_composite_toolsets` (518-531) reverse-maps tool names to configurable toolsets and subtracts `_default_off_toolsets`; `agent.disabled_toolsets` is subtracted LAST (596-602).

### Config/env keys

- `platform_toolsets.api_server` (list) — explicit per-platform toolset list; absence => default composite `hermes-api-server`.
- `agent.disabled_toolsets` — global suppression applied last.
- `known_builtin_toolsets.<platform>` — declined newly shipped toolsets (`tools_config.py:438-458`).
- `toolsets` (legacy) — `kanban` opt-in fallback (`tools_config.py:591-593`).
- `HASS_TOKEN` — presence lifts `homeassistant` out of default-off (`tools_config.py:483-485`).

### Reachable over POST /v1/runs? 

Yes — the run path uses platform `api_server`, whose default composite is `hermes-api-server` (`hermes_cli/platforms.py:35`, `toolsets.py:190-194`). Effective default = `hermes-api-server` tools minus `_DEFAULT_OFF_TOOLSETS` subsets (`homeassistant`, `kanban` etc. are stripped unless explicitly enabled). `clarify`, `text_to_speech`, `computer_use`, `kanban_*` are absent by construction.

### Limitations

- Several tools are further gated at registration by `check_fn` (HA needs `HASS_TOKEN`; kanban needs `HERMES_KANBAN_TASK`; browser/vision/image_gen need provider config) — `toolsets.py:7-10, 143-152`.
- Whether the api_server gateway applies additional per-run filtering (e.g. `tools` override in the run request) is covered in items 7-10 below; not settled by toolsets.py alone.

### Empirical test needed

- Actual tool list advertised to the model on a default `/v1/runs` run (call `GET /v1/tools` or inspect the first request) to confirm the check_fn-gated subset in the target deployment.

---

## 2. Terminal backends (tools/environments/*)

### Evidence

- `tools/environments/` contains `local.py`, `docker.py` (+`docker_egress.py`), `ssh.py`, `modal.py` (+`managed_modal.py`, `modal_utils.py`), `daytona.py`, `vercel_sandbox.py`, `singularity.py`, plus shared `base.py`, `base_session_env.py`, `remote_common.py`, `file_sync.py`.
- `tools/terminal_tool_backends.py:29` — `_BUILTIN_BACKENDS = "local, docker, singularity, modal, daytona, vercel_sandbox, ssh"`; `:205-207` — `_ENV_BUILDERS = {"local": _build_local_env, "docker": ..., "singularity": ..., "modal": ..., "daytona": ..., "vercel_sandbox": ..., "ssh": ...}`; unknown names fall through to plugin backends (`:183-201`, `agent.terminal_env_registry.plugin_backend_names`).
- `tools/terminal_tool_backends.py:103-104` — `_build_local_env(*, cwd, timeout, **_)` → `_LocalEnvironment(cwd=cwd, timeout=timeout)`; no image, no container.
- `tools/terminal_tool_backends.py:35-48` — config→kwargs tables: `_RESOURCE_KEYS` (`container_cpu`=1, `container_memory`=5120, `container_disk`=51200, `container_persistent`=True → `persistent_filesystem`), `_CONTAINER_KEYS` (docker_volumes, docker_mount_cwd_to_workspace, docker_forward_env, docker_env, docker_run_as_host_user, docker_extra_args, docker_shm_size "1g", docker_network True, docker_persist_across_processes True, docker_shared_container_key, docker_orphan_reaper True, docker_snap_compat False, modal_mode "auto", vercel_runtime "").
- `tools/terminal_tool.py:4` — docstring: `Backends (TERMINAL_ENV): local (default), docker, singularity, modal ...`.
- `tools/terminal_tool.py:611-660` — `_get_env_config()` reads only `TERMINAL_*` env vars: `TERMINAL_ENV` (default `"local"`), `TERMINAL_CWD`, `TERMINAL_TIMEOUT` (default `"180"` s), `TERMINAL_LIFETIME_SECONDS` (default 300), `TERMINAL_DOCKER_IMAGE` (default `nikolaik/python-nodejs:python3.11-nodejs20`), `TERMINAL_SINGULARITY_IMAGE`, `TERMINAL_MODAL_IMAGE`, `TERMINAL_DAYTONA_IMAGE`, `TERMINAL_VERCEL_RUNTIME`, `TERMINAL_MODAL_MODE` (auto), `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`, `TERMINAL_CONTAINER_{CPU,MEMORY,DISK}`, `TERMINAL_DOCKER_{FORWARD_ENV,VOLUMES,ENV,EXTRA_ARGS,SHM_SIZE}`, `TERMINAL_SSH_{HOST,USER,PORT,KEY,PERSISTENT}`, `TERMINAL_PERSISTENT_SHELL`.
- `hermes_cli/config.py:2013-2027` — `TERMINAL_CONFIG_ENV_MAP`: `terminal.backend` → `TERMINAL_ENV`; every other `terminal.<key>` → `TERMINAL_<KEY>` (cwd, timeout, lifetime_seconds, docker_image, ..., container_persistent, sandbox_dir, persistent_shell, degraded_mode, temp_dir).
- `tools/terminal_tool.py:560-574` — `_ensure_terminal_env_bridged()`: if `config.yaml` has a `terminal:` dict it is bridged into env with `override=True`; else only when `TERMINAL_ENV` is unset.
- `tools/terminal_tool.py:578-608` — `_resolve_config_cwd`: for `local`, default cwd = `_safe_getcwd()` (the Hermes process cwd); for `ssh` = `~`; other container backends default `/root`. For docker with `docker_mount_cwd_to_workspace`, host path mapped to `/workspace`; host paths that are unusable in a sandbox are dropped for container backends.
- `tools/environments/local.py:1` — `"""Local execution environment — spawn-per-call with session snapshot."""`; imports `local_env_policy` (`:22-25`) whose header (`local_env_policy.py:1-3`) describes a "Secret-scrub policy for Hermes child processes": Hermes-managed credentials (`_HERMES_PROVIDER_ENV_BLOCKLIST` `:82`, `_ALWAYS_STRIP_KEYS` `:199`, `_is_hermes_internal_secret` `:172`) are stripped from the subprocess env.
- `Dockerfile:169` `WORKDIR /opt/hermes`; `Dockerfile:391` `ENV HERMES_HOME=/opt/data`; `Dockerfile:309-323` — code in `/opt/hermes`, mutable HERMES_HOME volume at `/opt/data`. No `TERMINAL_ENV` is set in `Dockerfile`/`docker-compose.yml` (grep returned none), so the default `local` applies inside the image.

### Config/env keys

`terminal.backend` (env `TERMINAL_ENV`, default `local`), `terminal.cwd` (`TERMINAL_CWD`), `terminal.timeout` (`TERMINAL_TIMEOUT`, 180 s), `terminal.lifetime_seconds`, `terminal.container_persistent` (`TERMINAL_CONTAINER_PERSISTENT`, default true; only consumed by container backends), `terminal.docker_*`, `terminal.ssh_*`, `terminal.modal_mode`, `terminal.persistent_shell`, `terminal.sandbox_dir`, `terminal.degraded_mode`.

### What "local" means when Hermes itself runs in a container

`local` spawns a subprocess per call (`local.py:1`) in the Hermes process's own OS/container, with cwd defaulting to the Hermes process cwd (`terminal_tool.py:589`) — i.e. inside the Hermes container, alongside `/opt/hermes` and the `/opt/data` HERMES_HOME volume. Isolation is the container boundary itself plus env secret scrubbing; there is no per-run sandbox. The `docker` backend from inside a container requires a reachable Docker socket (not configured by the shipped compose file — no evidence in `docker-compose.yml`).

### Reachable over POST /v1/runs?

Yes — `terminal`/`process_manage` are in `hermes-api-server` (`toolsets.py:190-194`) and the backend is process-global (`_get_env_config()` reads env once per process; `terminal_tool.py:611`). Per-run backend selection is not evidenced.

### Limitations

- Backend is global per Hermes process, not per run/session.
- `container_persistent` has no effect on `local`.

### Empirical test needed

- Confirm in the target image that `TERMINAL_ENV` is unset (→ `local`) and what `_safe_getcwd()` resolves to for the gateway process (likely `/opt/hermes`).

---

## 3. Browser automation (tools/browser*)

### Evidence

- `tools/browser_tool.py:2` — `"""Browser automation tools driven by the agent-browser CLI."""`; `:124` `AGENT_BROWSER_NPX_SPEC = "agent-browser@^0.26.0"` (Node/npx process driving Chromium over CDP); `:146` engine option `--engine lightpanda` (agent-browser v0.25.3+).
- Alternate drivers/backends: `tools/browser_use_cli.py` (Browser Use CLI -> single `browser_exec` tool; selected via `browser.backend`, `:198,206`), `tools/browser_camofox.py` (Camofox REST backend; `is_camofox_mode()` `:93-112` — selected via `browser.cloud_provider: camofox` through `tools.tool_backend_helpers.read_selection("browser")`, legacy `CAMOFOX_URL`; a CDP override `BROWSER_CDP_URL`/`browser.cdp_url` wins), `tools/browser_tool_cloud.py` (cloud CDP providers), `tools/browser_lightpanda.py`, `tools/browser_tool_cdp.py`, `tools/browser_tool_real_profile.py`.
- `hermes_cli/config_defaults.py:380-425` — `browser` defaults: `backend: ""` (empty = Browser Use mode when the browser-use CLI/uvx is available, else built-in tools; `"browser-use"` = force `browser_exec`; `"off"` = force built-in `browser_navigate/...`), `inactivity_timeout: 120`, `command_timeout: 30`, `snapshot_threshold: 15000`, `record_sessions: False`, `headed: False`, `allow_private_urls: False`, `engine: "auto"` (also `AGENT_BROWSER_ENGINE`), `auto_local_for_private_urls: True`, `cdp_url: ""`, `use_real_profile: False`, `real_profile_autoclose: False`, `real_profile_pin: ""`, `allow_unsafe_evaluate: False`, `restrict_evaluate: False`.
- `toolsets.py:23-25` — built-in tools: `browser_navigate, browser_snapshot, browser_click, browser_type, browser_scroll, browser_back, browser_press, browser_get_images, browser_vision, browser_console, browser_cdp, browser_dialog`, plus `browser_vault_*` (5) and `browser_exec` (`:26`, "replaces the other browser tools when browser.backend is browser-use").
- State under HERMES_HOME: `tools/browser_camofox_state.py:18` -> `HERMES_HOME/browser_auth/camofox`; `tools/browser_tool.py:1109` and `browser_tool_lifecycle.py:538` -> `HERMES_HOME/browser_recordings`; `tools/browser_camofox.py:558` -> `HERMES_HOME/browser_screenshots`; `tools/browser_tool_install.py:43,150` -> managed Node at `HERMES_HOME/node`, `HERMES_HOME/node_modules/.bin`; `hermes_cli/config_defaults.py:406` — real-profile snapshot at `~/.hermes/browser-profile/` (deleted when `use_real_profile` is turned off).
- `tools/browser_tool_session.py:48-51` — `AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"` injected when not set (container-friendly Chromium flags); `:127-129` `AGENT_BROWSER_SOCKET_DIR`, `AGENT_BROWSER_IDLE_TIMEOUT_MS`.
- `tools/browser_tool.py:28-39` — the agent-browser subprocess env is credential-scrubbed.
- `tools/browser_tool_lifecycle.py:388-420` — background thread every 30 s closes sessions idle past `BROWSER_SESSION_INACTIVITY_TIMEOUT`, reaps orphans.

### Config/env keys

`browser.backend`, `browser.cloud_provider` (via `read_selection("browser")`), `browser.cdp_url` / `BROWSER_CDP_URL`, `browser.engine` / `AGENT_BROWSER_ENGINE`, `browser.headed`, `browser.allow_private_urls`, `browser.use_real_profile`, `browser.real_profile_pin`, `browser.record_sessions`, `browser.inactivity_timeout`, `browser.command_timeout`, `browser.snapshot_threshold`, `browser.restrict_evaluate`, `browser.allow_unsafe_evaluate`, `CAMOFOX_URL`, `AGENT_BROWSER_ARGS`, `AGENT_BROWSER_HEADED`, `AGENT_BROWSER_IDLE_TIMEOUT_MS`.

### Reachable over POST /v1/runs?

Yes — every core `browser_*` tool is kept in `hermes-api-server` (`toolsets.py:190-194`); the `browser` toolset is configurable and not in `_DEFAULT_OFF_TOOLSETS`. Registration still depends on agent-browser/Node or the Browser Use CLI being installed (`tools/browser_tool_install.py`).

### Limitations

- Default cookie/profile persistence for the built-in agent-browser driver (per-session vs persistent profile dir) is not evidenced in the files read; Camofox keeps a persistent profile under `HERMES_HOME/browser_auth/camofox` (`browser_tool_lifecycle.py:638` comment: "managed persistence keeps the profile (cookies) across tasks").
- `browser_vault_*` storage location not located in this pass.

### Empirical test needed

- Whether headless Chromium launches in the target container (memory budget) and whether logins persist across `/v1/runs` runs.

---

## 4. File tools: read_file document extraction, char budget, OCR fallback

### Evidence

- `tools/read_extract.py:3` — extraction uses the optional `firecrawl-anydoc` package (imports as `anydoc`).
- `tools/read_extract.py:29-36` — `EXTRACTABLE_EXTENSIONS = {".ipynb", ".docx", ".xlsx"}` handled natively (zip/XML parsing), `ANYDOC_EXTENSIONS = {.doc, .docm, .ppt, .pps, .pot, .pptx, .pptm, .ppsx, .ppsm, .xls, .xlsm, .xlsb, .odt, .ods, .odp, .rtf, .epub, .pdf}` require anydoc; `MAX_ANYDOC_BYTES = MAX_DOCUMENT_BYTES = 50 MiB`; `_MAX_XLSX_ROWS_PER_SHEET = 5000`, `_MAX_XLSX_COLS = 256`.
- `tools/read_extract.py:33` — comment: anydoc loads whole files (no streaming); the read_file char budget applies only post-conversion.
- `tools/read_extract.py:64-84` — lazy import of `anydoc`; failure cached and retried after `ANYDOC_RETRY_SECONDS`. `:129-140` — when missing, `read_file` returns teaching text: cannot convert, needs the optional anydoc converter, `pip install firecrawl-anydoc`.
- `tools/read_extract.py:145-159` — `_hosted_ocr_config()`: hosted OCR only via direct `FIRECRAWL_API_KEY` (read through `agent.secret_scope.get_secret`); `file_tools.hosted_ocr: false` disables even with a key; the Nous gateway Parse proxy is explicitly NOT used.
- `tools/read_extract.py:167-180` — `_needs_ocr_warning`: emits `[NEEDS OCR: pages ... of this PDF are scanned images with no text layer — their content is MISSING below ...]` with a `pdftoppm` + `vision_analyze` hint and a hint to check `skills_list` for an OCR skill.
- `tools/read_extract.py:191-203` — `_ocr_scanned_pdf(mod, path, exc)`: on anydoc `NeedsOcrError`, tries `mod.to_markdown(path, ocr="hosted", api_key=...)` when a key exists; otherwise returns the warning as the whole result.
- `tools/read_extract.py:205-215` — `_extract_anydoc`: size check, `mod.to_markdown(path)`, catches `mod.NeedsOcrError`.
- `tools/file_tools.py:46-54` — `file_read_max_chars` read from config.yaml; `hermes_cli/config_defaults.py:480` — default `100_000` chars (comment: ~25-35K tokens).

### Config/env keys

`file_read_max_chars` (top-level config key, default 100000), `file_tools.hosted_ocr` (bool), `FIRECRAWL_API_KEY` (secret-scoped), optional dependency `firecrawl-anydoc`.

### Reachable over POST /v1/runs?

Yes — `read_file` is in `hermes-api-server` via the `file` toolset. PDF/PPTX conversion depends on `firecrawl-anydoc` being installed in the runtime image (Dockerfile not checked for it in this pass).

### Limitations

- Whole-file load, 50 MiB cap; scanned PDFs without `FIRECRAWL_API_KEY` yield only the NEEDS-OCR marker plus `pdftoppm`/`vision_analyze` guidance.

### Empirical test needed

- `python -c "import anydoc"` inside the deployed image; behaviour of `read_file` on a scanned PDF.

---

## 5. Skills: tools, automatic learning (background review), curator, write approval

### Evidence — skill tools

- `toolsets.py:102-106` — `skills` toolset = `skills_list`, `skill_view`, `skill_manage`; included in `hermes-api-server` (`toolsets.py:190-194`).
- `tools/skill_manager_tool.py:840` — `skill_manage` action enum: `["create", "patch", "delete", "write_file", "remove_file"]` (an internal `edit` path also exists, `:422-424`). Constants `:84-90`: `MAX_NAME_LENGTH = 64`, `MAX_DESCRIPTION_LENGTH = 1024`, `MAX_SKILL_CONTENT_CHARS = 100_000`, `MAX_SKILL_FILE_BYTES = 1 MiB`, `VALID_NAME_RE = ^[a-z0-9][a-z0-9._-]*$`, `ALLOWED_SUBDIRS = {"references", "templates", "scripts", "assets"}` for `write_file`/`remove_file`.
- `tools/skill_manager_tool.py:5` — docstring: new skills land in `~/.hermes/skills/` (or `skills.create_dir`). `:72-80` `_skills_dir()` = `get_hermes_home() / "skills"` for the active profile (rebinds per session in multi-profile runtimes). `:185-192` — new-skill dir = `get_skill_create_dir()` (config `skills.create_dir`, "e.g. a shared fleet dir") or the profile skills dir, then `/<category>/<name>`.
- `tools/skill_manager_tool.py:208-221` — listing/lookup iterates `agent.skill_utils.get_all_skills_dirs()` (multiple roots), not only the profile dir.
- `tools/skill_manager_tool.py:581-610, 625` — `_run_write_gate(build_staging)` consults `tools.write_approval`; when staging, returns `{"success": True, "staged": True, "pending_id": ...}`; `apply_skill_pending(payload)` applies a staged record.
- `tools/write_approval.py:1-10` — docstring: per-subsystem boolean `write_approval` gates cross-session writes for memory (MEMORY.md/USER.md) and skills (SKILL.md + files) from either origin (foreground turn or background_review fork). `false` (default) writes freely; `true` never commits directly: prompts inline (memory, interactive CLI only) or stages under `<HERMES_HOME>/pending/{memory,skills}/<id>.json` for out-of-band review. `hermes_cli/config_defaults.py:1221,1376` — `write_approval: False` for both `memory` and `skills` sections.

### Evidence — automatic learning (agent/background_review.py)

- `agent/background_review.py:1-6` — docstring: after every turn `AIAgent.run_conversation` may spawn a daemon thread that replays the conversation snapshot in a forked `AIAgent` and asks whether any skill/memory should be saved or updated; writes go straight to the memory + skill stores; the fork inherits the parent runtime (same prefix cache) and runs under a dispatch-side tool whitelist.
- Trigger site: `agent/turn_finalizer.py:595-599` — `_should_review_skills = agent._skill_nudge_interval > 0 and agent._iters_since_skill >= agent._skill_nudge_interval and "skill_manage" in agent.valid_tool_names` (checked per turn on tool-iteration count). `agent/agent_init.py:1301-1303` — `_skill_nudge_interval` default `10`, config `agent.skills.creation_nudge_interval`; `agent_init.py:1257` — `_memory_nudge_interval` default `10`, config `memory.nudge_interval`.
- `agent/turn_finalizer.py:609-624` — comment: review runs AFTER delivery; suppressed by `skip_background_review` (e.g. cron: ~30K tokens/event). Condition: `final_response and not interrupted and not agent.skip_background_review and (_should_review_memory or _should_review_skills)` → `agent._spawn_background_review(messages_snapshot=list(messages), review_memory=..., review_skills=...)`. Second call site: `agent/codex_runtime.py:464`.
- `run_agent.py:740-770` — `_spawn_background_review`: returns early when `agent._delegate_depth > 0` (delegated children never review); reads `load_background_review_settings()` and returns if not enabled; may defer to `agent.review_idle_queue.QUEUE` when the runtime is a managed local llama-server (`_review_should_defer`), else `_spawn_background_review_now`.
- `run_agent.py:772-809` — `_spawn_background_review_now`: `threading.Thread(target=..., daemon=True, name="bg-review").start()` — a daemon thread in the SAME process; profile context propagated via `propagate_context_to_thread`.
- `agent/background_review.py:188-202` — `load_background_review_settings()` reads `auxiliary.background_review` block; `enabled` default True, fail-open (a config read error leaves reviews enabled and logs a warning).
- `hermes_cli/config_defaults.py:748` — `"background_review": {"enabled": True, **_aux(120), "max_input_tokens": 600000}` (aux timeout 120 s; provider/model routable via `auxiliary.background_review.{provider,model}`, `background_review.py:206-225`).
- `agent/background_review.py:1025-1040` — `_review_tool_whitelist`: review toolsets = `["memory", "skills"]` when memory is on and the memory trigger fired, else `["skills"]`; plus `read_file`, `search_files`; write tools stay denied (skill writes go through `skill_manage` validation). `:1054` — `auxiliary.background_review.extra_tools` admits extra parent tools. `:1107-1110` — `set_thread_tool_whitelist(...)` denies non-whitelisted tools.
- Platform gating: `skip_background_review` is set only by `cron/scheduler.py:2213` (`skip_background_review=True`) and the `agent_init.py:2201,2236` constructor parameter. No setter in `gateway/` (grep over `gateway/` returned none) → api_server agents keep the default `False` and DO run background review when the nudge counters fire.
- Process lifetime: the review is a daemon thread of the gateway process, spawned inside `run_conversation`'s finalizer (i.e., before the api_server run loop emits its terminal event). It needs the gateway process to stay alive to finish; it is not tied to the HTTP request or SSE stream. `background_review.py:115` also has a `bg-review-cancel` daemon thread and `_BACKGROUND_REVIEW_CANCEL_TIMEOUT_SECONDS = 2.0` (`:24`) for cancellation when a new turn preempts it (`run_agent.py:_maybe_requeue_preempted_review`, bounded `_REVIEW_REQUEUE_MAX_ATTEMPTS = 3`, `:812`).
- What it writes: `MEMORY.md`/`USER.md` via the `memory` tool (add-only for the review fork: `background_review.py:1105` "memory for notes (add only)") and skills under the profile skills dir / `skills.create_dir` via `skill_manage` (`skill_manager_tool.py:459` has a `_background_review_read_before_write_guard` for `patch`). When `skills.write_approval`/`memory.write_approval` is true, writes are staged to `HERMES_HOME/pending/...` instead.

### Evidence — curator

- `agent/curator.py:1-7` — "Curator — background skill maintenance orchestrator. Inactivity-triggered (no cron daemon): when the agent is idle and the last run is older than `interval_hours`, `maybe_run_curator()` auto-transitions lifecycle states from activity timestamps, optionally forks an AIAgent that may pin/archive/consolidate/patch skills via skill_manage, and persists scheduler state in `.curator_state`. Invariants: only curator-managed skills are touched; never delete, only archive (recoverable); pinned skills bypass all auto-transitions; the fork uses the auxiliary client".
- `agent/curator.py:29-31` — defaults: `DEFAULT_INTERVAL_HOURS = 168` (7 days), `DEFAULT_MIN_IDLE_HOURS = 2`, `DEFAULT_STALE_AFTER_DAYS = 14`, `DEFAULT_ARCHIVE_AFTER_DAYS = 30`; `:142-161` `should_run_now()` — gates on `curator.enabled`, not paused, `last_run_at` older than `interval_hours`; the FIRST observation only seeds `last_run_at` and defers one interval.
- `hermes_cli/config_defaults.py:1388-1402` — `curator: {enabled: True, interval_hours: 168, min_idle_hours: 2, stale_after_days: 14, archive_after_days: 30, consolidate: False (LLM consolidation pass OFF by default = deterministic inactivity prune only), prune_builtins: True, ...}`.
- Trigger: `gateway/run.py:4467-4470, 4568` — gateway housekeeping loop entry `(60, "Curator tick", _housekeeping_curator)` polls `maybe_run_curator(idle_for_seconds=inf)` every 60 s; `hermes_cli/curator.py` is the CLI (`hermes curator status|run|pause|resume|pin|unpin|list-unmanaged|adopt|restore|archive`).

### Config/env keys

`skills.create_dir`, `skills.write_approval` (default false), `memory.write_approval` (default false), `agent.skills.creation_nudge_interval` (10), `memory.nudge_interval` (10), `auxiliary.background_review.enabled` (true), `.provider`, `.model`, `.timeout` (120), `.max_input_tokens` (600000), `.extra_tools`, `.defer`; `curator.*` as above; `HERMES_HOME` (skills at `HERMES_HOME/skills`, pending at `HERMES_HOME/pending/{memory,skills}`, state `.curator_state`).

### Reachable over POST /v1/runs?

- `skills_list`/`skill_view`/`skill_manage`: yes (in `hermes-api-server`).
- Background review: yes, conditional — runs for api_server agents because nothing in `gateway/` sets `skip_background_review` (`turn_finalizer.py:612-616`), provided `_delegate_depth == 0`, `final_response` non-empty, not interrupted, `auxiliary.background_review.enabled` true, and a nudge counter (`_iters_since_skill >= 10` or the memory equivalent) has fired that turn. It is skipped for the cron platform (`cron/scheduler.py:2213`).
- Curator: not per-run; gateway-process housekeeping tick (runs when the gateway hosting api_server is up, regardless of platform).

### Limitations

- Review fork spends ~30K tokens/event (comment at `turn_finalizer.py:610`); only triggered after 10 tool iterations accumulate.
- The review is a daemon thread: a gateway restart/redeploy right after a run's terminal event can lose an in-flight review (no persistence of the pending review evidenced).

### Empirical test needed

- Exact `_should_review_memory` condition (definition not located by grep in `agent/turn_finalizer.py` in this pass — likely computed earlier in the finalizer from `_iters_since_memory`/`_memory_nudge_interval`).
- Whether a `/v1/runs` run with >=10 tool iterations produces a `bg-review` thread and a skill write in the deployed image.

---

## 6. Memory: built-in MEMORY.md/USER.md, external provider, hooks, session search

### Evidence

- `hermes_cli/config_defaults.py:1215-1229` — `memory` defaults: `memory_enabled: True`, `user_profile_enabled: True`, `write_approval: False`, `memory_char_limit: 2200` (~800 tokens), `user_char_limit: 1375` (~500 tokens), `nudge_interval: 10`, `provider: ""` (empty = built-in only; ONE external provider at a time: "openviking", "mem0", "hindsight", "holographic", "retaindb", "byterover").
- `tools/memory_tool.py:222-225` — `get_builtin_memory_store_flags(config)` returns `(memory_enabled, user_profile_enabled)` from the `memory` section, each defaulting to True; `:228-234` `check_memory_requirements()` registers the `memory` tool only if at least one flag is on. (The function lives in `tools/memory_tool.py`, re-exported/used by `agent/agent_init.py`; not in `agent/memory_manager.py`.)
- `agent/agent_init.py:1243-1263` — built-in store init: memory is loaded when `not skip_memory or "memory" toolset requested`; `MemoryStore(memory_char_limit, user_char_limit, memory_enabled, user_profile_enabled).load_from_disk()`; `_memory_nudge_interval = memory.nudge_interval` (10).
- `agent/agent_init.py:1265-1296` — external provider: `mem_config.get("provider")` → `plugins.memory.load_memory_provider(name)`; if `is_available()`, added to a `MemoryManager` and `initialize_all(**_memory_provider_init_kwargs(agent, platform))`; unavailable providers log a one-time warning; `inject_memory_provider_tools(agent)` (`:1299`) adds provider tools. Built-in and external run alongside each other (comment `:1265`).
- `plugins/memory/` — bundled providers: `byterover, hindsight, holographic, honcho, mem0, openviking, retaindb, supermemory` (+ `config_schema.py`, `query_rewrite.py`).
- `agent/memory_provider.py:84-185` — provider hook surface: `name`, `is_available`, `initialize(session_id, **kwargs)`, `unavailable_reason`, `system_prompt_block`, `prefetch(query, session_id)`, `sync_turn(...)`, `handle_tool_call(tool_name, args)`, `shutdown`, `on_turn_start(turn_number, message)`, `on_session_end(messages)`, `on_session_switch(...)`, `on_pre_compress(messages)`, `on_delegation(task, result, child_session_id)`, `on_memory_write(action, target, content, metadata)`.
- `agent/turn_finalizer.py:603-607` — `agent._sync_external_memory_for_turn(original_user_message, final_response, interrupted, messages)` runs each turn; `:627-628` comment: `on_session_end()/shutdown_all()` are NOT called by `run_conversation` — CLI/gateway own session-end cleanup.
- Session search: `hermes_state_search.py:1-4` — "Full-text / trigram / CJK message search and FTS maintenance for SessionDB" (SQLite FTS5; `_FTS5_SPECIAL_CHARS` `:37`, `MAX_FTS5_QUERY_CHARS`, trigram tables `FTS_TRIGRAM_SQL`, external-content v23 tables `:459`). `tools/session_search_tool.py:508-536` — `session_search(query, role_filter, limit=3, session_id, around_message_id, window=5, sort, profile, detail="adaptive")` acquires the `SessionDB` via `hermes_state_registry.acquire`; `check_session_search_requirements()` requires the SQLite state DB path to exist. Registered as tool `session_search`, toolset `session_search` (`:646-647`).

### Config/env keys

`memory.memory_enabled`, `memory.user_profile_enabled`, `memory.write_approval`, `memory.memory_char_limit`, `memory.user_char_limit`, `memory.nudge_interval`, `memory.provider` (+ provider-specific sections under `plugins/memory/<name>`); MEMORY.md/USER.md live under the profile `HERMES_HOME` (`MemoryStore.load_from_disk`, path not read in this pass).

### Reachable over POST /v1/runs?

Yes — `memory` and `session_search` toolsets are in `hermes-api-server`; the memory tool registers when either store flag is true. External provider tools are injected per agent regardless of platform (`agent_init.py:1299`). Memory content is shared across all api_server sessions of the same profile (single MEMORY.md/USER.md per HERMES_HOME profile).

### Limitations

- Bounded store (2200 + 1375 chars) injected into the system prompt; not per-tenant unless separate profiles/HERMES_HOME are used.
- `on_session_end` for providers depends on the gateway calling it; behaviour for api_server sessions not traced here.

### Empirical test needed

- Whether the api_server gateway invokes provider `on_session_end`/`shutdown` for `/v1/runs` sessions.

---

## 7. Delegation (tools/delegate_tool.py, tools/async_delegation.py)

### Evidence

- `toolsets.py:143` — `delegation` toolset = `delegate_task`; kept in `hermes-api-server` (`toolsets.py:190-194`).
- Child construction: `tools/delegate_tool.py:240` — child `AIAgent(...)` is built with `skip_context_files=True, skip_memory=True, clarify_callback=None`. `agent/agent_init.py:2218` — `skip_context_files: skip SOUL.md/.hermes.md/AGENTS.md/CLAUDE.md/.cursorrules injection` → children get no SOUL.md/AGENTS.md and no built-in memory. `tools/delegate_tool_child_run.py:105-106` — fields copied into the child: `model, provider, api_mode, base_url, max_iterations, quiet_mode, skip_memory, skip_context_files, platform, _delegate_role, _delegate_depth`.
- Depth: `tools/delegate_tool_config.py:21` — `MAX_DEPTH = 1  # flat by default: parent (0) -> child (1); deeper needs max_spawn_depth`; `:141-152` `_get_max_spawn_depth()` reads `delegation.max_spawn_depth`, floored at 1, no ceiling. `tools/delegate_tool.py:449-456` — `if depth >= max_spawn: return tool_error("Delegation depth limit reached ...")`. `:187-190` — a child is an `orchestrator` (may delegate) only if `_get_orchestrator_enabled()` and `child_depth < max_spawn`, else `leaf`; the `role` argument is ignored.
- Count: `tools/delegate_tool_config.py:85-97` — `_get_max_concurrent_children()`: `delegation.max_concurrent_children` > env `DELEGATION_MAX_CONCURRENT_CHILDREN` > default 10; warns when configured above 10. `:114-124` — the background/async concurrency cap is the same value. `tools/delegate_tool.py:477-478` — `_normalize_task_list(..., max_children)` enforces the batch size.
- Sync vs async: `tools/delegate_tool.py:195-197` — `background` (truthy flag) applies to single tasks AND batches; a batch is ONE async unit that joins on every child and re-enters as a single consolidated message. `tools/async_delegation.py:1-8` — the parent dispatches on a module-level daemon executor and returns a handle immediately; on completion a `type="async_delegation"` event is pushed onto the shared `process_registry.completion_queue` that the CLI/gateway drain while idle, so results surface as a NEW turn (never mid-turn). `:860` — stall detection message for detached subagents; `:734` — one failed child of a still-running batch may be surfaced early.
- api_server specifics (wake contract, #98619): `tools/async_delegation.py:496-507` — `_current_origin_session_id()` returns the request-scoped `HERMES_SESSION_CHAT_ID` only when `HERMES_SESSION_PLATFORM == "api_server"`; otherwise `""`. `gateway/platforms/api_server_runs.py:533-534` — comment: chat_id carries the raw session id; "without it tools.async_delegation sees no HERMES_SESSION_CHAT_ID and forces delegations sync". `:539-548` — "#98619 audited opt-in: the /v1/runs session id is wake-capable only when its own continuation path reloads session history — an explicit body/chained session id or a declared X-Hermes-Session-Key conversation (both load SessionDB in _handle_runs), or the run_id fallback the client can post back as body.session_id. A previous_response_id continuation consumes its ResponseStore snapshot instead and can never see a SessionDB delivery row, so it stays default-denied until a merge contract exists for that chain; likewise a caller-supplied conversation_history is authoritative for the turn and never reads the delivery row, so it is denied the same way." `:472` — `session_history_delivery = not previous_response_id and not conversation_history`; `:325-329` dataclass comment restates the rule.
- Children never spawn background review: `run_agent.py:749-750` (`_delegate_depth > 0` → return).

### Config/env keys

`delegation.max_spawn_depth` (default 1), `delegation.max_concurrent_children` / `DELEGATION_MAX_CONCURRENT_CHILDREN` (default 10), `delegation.orchestrator` kill switch (`_get_orchestrator_enabled`), `delegation.provider`/`model` overrides (`config_defaults.py:1230-1231`), child timeout (`_get_child_timeout`), worktree isolation (`_get_worktree_isolation`), `max_iterations` (config value authoritative, `delegate_tool.py:458-460`).

### Reachable over POST /v1/runs?

Yes. Sync delegation always works. Async (`background=true`) is conditional: it requires a session id bound as `HERMES_SESSION_CHAT_ID` (`api_server_runs.py:535`), otherwise it is forced sync; and delivery of the detached result to the client is only possible ("wake-capable") when the follow-up run reloads SessionDB history (explicit `session_id` / `X-Hermes-Session-Key`), not for `previous_response_id` or `conversation_history` continuations (`api_server_runs.py:539-548`). There is no push channel: the result is persisted as a SessionDB delivery row and surfaces as a new turn when the client posts the next run for that session.

### Limitations

- Children have no SOUL.md/AGENTS.md, no memory, no clarify; flat depth by default.
- Detached results depend on the client posting another run with the same session id; a `previous_response_id` chain never receives them.

### Empirical test needed

- Whether the detached-child completion is emitted as an event on the NEXT run's SSE stream or only merged into history; behaviour of `background=true` on a run with no `session_id` (expected: forced sync).

---

## 8. Approvals over api_server — blocking wait vs auto-deny

### Evidence (trace)

1. Platform binding: `gateway/platforms/api_server.py:3583-3597` — `_bind_api_server_session(...)` calls `set_session_vars(platform="api_server", chat_id=..., session_key=..., session_id=..., ...)`. `api_server_runs.py:531-548` — `_run_agent_sync` binds this for every `/v1/runs` run (`set_current_session_key(run.approval_session_key)` where `approval_session_key == run_id`, `:337-339`), then `register_gateway_notify(run.approval_session_key, approval_notify)` (`:554`), then `agent.run_conversation(...)`.
2. Unattended classification: `tools/approval_context.py:131-134` — `_UNATTENDED_APPROVAL_PLATFORMS = frozenset({"webhook", "msgraph_webhook", "api_server"})`; `:137-145` `_is_unattended_platform_approval_context()` = `_get_session_platform() in _UNATTENDED_APPROVAL_PLATFORMS` where `_get_session_platform()` (`:121-123`) reads `HERMES_SESSION_PLATFORM` from the session contextvars → True for api_server runs.
3. Gateway presence is denied for unattended platforms: `tools/approval_context.py:165-173` (inside `_is_gateway_approval_context()`, def at `:157`): "Unattended programmatic platforms (webhook, msgraph_webhook, api_server) are excluded ... Their dangerous-command handling is governed by `approvals.unattended_mode` config (default deny), mirroring cron." followed by `if _is_cron_approval_context() or _is_unattended_platform_approval_context(): return False`.
4. Presence tuple: `tools/approval.py:869-878` — `_presence()` → `is_cli = _is_interactive_cli()`, `is_gateway = _is_gateway_approval_context()` (False for api_server), `is_ask = env_var_enabled("HERMES_EXEC_ASK")`.
5. Terminal command gate — the deciding lines: `tools/approval.py:1079` `def check_all_command_guards(command, env_type, ..., approval_callback=None, has_host_access=False)`; `:1098-1106`:
   ```
   approval_callback, is_cli, is_gateway, is_ask = _presence(approval_callback)
   # Outside CLI/gateway/ask flows we never block on approvals: each
   # unattended context applies its configured deny/approve mode, else allow.
   if not is_cli and not is_gateway and not is_ask:
       for ctx in _unattended_contexts():
           result = _unattended_deny(command, ctx)
           if result is not None:
               return result
       return _approved()
   ```
   `tools/approval.py:566-583` — `_unattended_contexts()` appends the `unattended` context (`"unattended_mode"`, "this session runs on an unattended platform (api_server) with no user present to approve it") when `_is_unattended_platform_approval_context()`. `tools/approval_context.py:280-284` — `_get_unattended_approval_mode()` = `_binary_approval_mode("unattended_mode")`, "default deny". `:585-586` `_unattended_deny(command, ctx)` returns the BLOCKED dict in deny mode, `None` (= allow) in approve mode.
6. Generic action gate: `tools/approval.py:881-935` — `_run_approval_gate` (used by `request_tool_approval` `:1015-1030` and file-write gates): `if not is_cli and not is_gateway:` → iterate `_unattended_contexts()`; deny mode → `_blocked(message)` instantly ("Every unattended context resolves instantly — never a pending approval nobody can answer" `:911`); approve mode → `break` → auto-approve.
7. Smart mode: `tools/approval.py:725-738` — in `_smart_gate`, a smart DENY with no human present returns `BLOCKED by smart approval ... Do NOT retry` immediately ("Unattended programmatic platforms (webhook/msgraph_webhook/ api_server): respect unattended_mode config. Resolves instantly").
8. The blocking gateway path exists but is reached only when `is_gateway or is_ask`: `tools/approval.py:800-829` — `if is_gateway or is_ask:` → `notify_cb = _gateway_notify_cb(session_key)` (`:489-491`, registry filled by `register_gateway_notify` `:122-126`) → `_await_gateway_decision(session_key, notify_cb, data, surface="gateway")` blocks the agent thread until resolved or timeout ("Silence is not consent" → BLOCKED). `:836-848` — when no notify_cb and no CLI fallback, `_pending_result` (`:494-533`) queues a `pending_approval` for `/approve`/`/deny`. The api_server side: `api_server_runs.py:579-596` `_make_approval_notify` emits `approval.request` and sets status `waiting_for_approval`; `:777-826` `POST /v1/runs/{run_id}/approval` → `resolve_gateway_approval(approval_session_key, choice, ...)`; 409 `approval_not_active`/`approval_not_pending` when nothing is pending.

### Conclusion

For a dangerous terminal command on a `/v1/runs` run with default config, the answer is **(b) auto-denied**: `is_gateway` is False because `api_server` is in `_UNATTENDED_APPROVAL_PLATFORMS` (`approval_context.py:134,172-173`), so `check_all_command_guards` takes the `not is_cli and not is_gateway and not is_ask` branch (`approval.py:1101`) and returns `_unattended_deny(...)` under `approvals.unattended_mode` default `deny` — no `approval.request` event is emitted and `register_gateway_notify` is never consulted. With `approvals.unattended_mode: approve` the command auto-runs (`return _approved()`, `approval.py:1106`). The registered notify callback / `approval.request` / `POST /v1/runs/{id}/approval` machinery only engages if the process is configured so that `is_ask` or `is_cli` is True — `HERMES_EXEC_ASK=1` (`approval.py:875`) or `HERMES_INTERACTIVE` (`_is_interactive_cli`) — in which case `_human_decision` at `approval.py:800` uses `notify_cb` and **(a) blocks** on `_await_gateway_decision` until `POST /v1/runs/{id}/approval` or timeout. Also bypassed entirely by `approvals.mode: off` or yolo (`approval.py:1093-1094`), and by the permanent allowlist (`:1095`).

### Config/env keys

`approvals.unattended_mode` (deny|approve; default deny), `approvals.mode` (off|smart|... ; `off` bypasses), `approvals.cron_mode`, `approvals.single_query_mode`, `HERMES_EXEC_ASK`, `HERMES_INTERACTIVE`, `HERMES_SESSION_PLATFORM` (bound per run), `security.tirith_fail_open`.

### Reachable over POST /v1/runs?

Approval-gated commands: default → instant BLOCKED result returned to the model (run continues, no client interaction). The `/v1/runs/{id}/approval` endpoint is live but returns 409 `approval_not_pending` unless the gate reached the gateway-wait path.

### Limitations

- Approval semantics are process-global (env-driven `HERMES_EXEC_ASK`), not per run.

### Empirical test needed

- Confirm in the deployed gateway whether `HERMES_EXEC_ASK`/`HERMES_INTERACTIVE` are set (they flip the outcome from (b) to (a)); observe the run status for a `rm -rf` style command.

---

## 9. Clarification (tools/clarify_tool.py) on api_server

### Evidence

- `tools/clarify_tool.py:17` — `_UNAVAILABLE = "Clarify tool is not available in this execution context."`; `:182-183` `clarify_tool(question, choices, multi_select, questions, callback=None)`; `:204-205` (batch) and `:220-221` (single): `if callback is None: return tool_error(_UNAVAILABLE)`. Docstring `:194-198`: the callback is "Platform-provided ... Injected by the agent runner (cli.py / gateway)".
- `gateway/platforms/api_server.py:2150-2179` — `_create_agent` builds `agent_kwargs = {model, ..., "enabled_toolsets": enabled_toolsets, "session_id", "platform": "api_server", stream/tool callbacks, "session_db", "fallback_model", "reasoning_config", "gateway_session_key"}` then `AIAgent(**agent_kwargs)`; no `clarify_callback` key. `enabled_toolsets = sorted(_get_platform_tools(user_config, "api_server"))` (`:2151`) → default `hermes-api-server`, which excludes `clarify` (`toolsets.py:190-194`).
- Grep of `gateway/` and `tui_gateway/` for `set_clarify_callback` / `clarify_callback=` returned no files; grep of `gateway/platforms/api_server*.py` for `clarify` returned no lines.
- Shared factory: `_create_agent` is called from `gateway/platforms/api_server.py:3702` (the chat/completions/responses/sessions turn path) and `gateway/platforms/api_server_runs.py:627` (`/v1/runs`), so `/api/sessions/{id}/chat`, `/v1/chat/completions`, `/v1/responses` and `/v1/runs` all construct agents without a clarify callback.

### Config/env keys

`platform_toolsets.api_server` (adding `clarify` re-advertises the tool but does not supply a callback).

### Reachable over POST /v1/runs?

No, by default the `clarify` tool is not in the toolset. If force-enabled, it returns `tool_error("Clarify tool is not available in this execution context.")` (`clarify_tool.py:17,220`). `/api/sessions/{id}/chat` and `/v1/responses` do not differ (same `_create_agent`).

### Limitations

- No API-side mechanism (event + reply endpoint) for clarification questions exists in the api_server platform files read.

### Empirical test needed

- None for the default path; optionally confirm the error string when `clarify` is added to `platform_toolsets.api_server`.

---

## 10. File ingestion over the API

### Evidence

- `gateway/platforms/api_server.py:451-452` — `_IMAGE_PART_TYPES = frozenset({"image_url", "input_image"})`, `_FILE_PART_TYPES = frozenset({"file", "input_file"})`.
- `gateway/platforms/api_server.py:485-524` — `_normalize_chat_content` (shared multimodal validator; docstring `:489-490`: raises `ValueError("unsupported_content_type:...")` for file parts, non-image data URLs, unknown types). `:514-517`: `elif part_type in _FILE_PART_TYPES: raise ValueError("unsupported_content_type:Inline image inputs are supported, but uploaded files and document inputs are not supported on this endpoint.")`; `:518-521` unknown part types likewise rejected ("Only text and image_url/input_image parts are supported."); `:472` non-image data URLs rejected ("Only image data URLs are supported"). The `<code>:<message>` ValueError is mapped to a 400 OpenAI-style error by the route handlers (mapping site not read in this pass; `api_server_openai_routes.py` contains no `unsupported_content_type` string — the check lives in `api_server.py`).
- `/v1/artifacts/upload`: `gateway/platforms/api_server.py:99-100, 1537-1538` route table; `:2579` `_handle_artifact_upload`. Docstring ladder (`:2590-2593`): "404 disabled, 403 no API key, 401 bad Bearer, 429 rate limited, 413 too large, 415 MIME rejected, 400 missing filename/scope, 201"; returns "a provenance receipt (never a filesystem path)". Principal: `:2581` `principal = self._derive_browser_control_principal(profile)`; rate limiter keyed `f"{action}:{principal}"`; `:2615` `scope = _ArtifactScopeFacade(principal, transport_family=self._browser_control_transport_family(request))`.
- `gateway/browser_control_artifacts.py:89-105` — `artifact_scope_key(scope)`: only principal (mandatory) + transport family participate; `session_id` deliberately EXCLUDED; `if not principal: raise ArtifactError("artifact scope must carry a resolved principal")` ("Fail closed: only an authenticated principal may mint artifacts"). `:25` `DEFAULT_MAX_ARTIFACT_BYTES = 10 MiB`; `:27-28` `DEFAULT_ALLOWED_MIME_TYPES = {application/json, application/pdf, image/gif, image/jpeg, image/png, image/webp, text/plain, ...}`; TTL `DEFAULT_ARTIFACT_TTL_SECONDS`.
- Consumption: `gateway/platforms/api_server.py:2628-2640` `GET /v1/artifacts/download/{artifact_id}` loads with the same scope; the store is otherwise referenced only by `gateway/browser_control_broker.py` (browser-control/extension transport). No code path found that places an uploaded artifact into an agent turn or onto the agent-visible filesystem.

### Config/env keys

Artifact store enable flag (404 when disabled), API key/Bearer auth (`API_SERVER_KEY`), artifact TTL/max bytes/MIME allowlist (constructor args, `browser_control_artifacts.py:116-117`).

### Reachable over POST /v1/runs?

- `file`/`input_file` parts: rejected with 400 `unsupported_content_type` by the shared validator on `/v1/chat/completions` and `/v1/responses`; `/v1/runs` uses the same content shape (runs build `user_message`/`conversation_history` from the same request normalisation — exact call site not read; see Empirical).
- `/v1/artifacts/upload`: scoped to a browser-control principal and returns only a receipt/download URL; not a document hand-off to the agent.
- Answer to "any API-side way other than the filesystem?": none found. Accepted inputs are text (capped by `_cap_text`) and inline image data URLs. Documents must be pre-placed on the agent-visible filesystem (host/volume/`TERMINAL_CWD`) or fetched by the agent itself (e.g., `web_extract`, `terminal` `curl`) from a URL.

### Limitations

- Inline text is size-capped (`_cap_text`, `_cap_list`); PDF/DOCX cannot be passed as base64 through chat content.

### Empirical test needed

- Confirm `/v1/runs` returns 400 `unsupported_content_type` for an `input_file` part (validator site for runs not read).
- Confirm a `/v1/artifacts/upload` receipt is not resolvable by `read_file` inside the run (expected: not — store path is internal).

