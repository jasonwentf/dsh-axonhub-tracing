# dsh-axonhub-tracing

[中文](README.md) | English

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4B32C3.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](#)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#)
[![AxonHub](https://img.shields.io/badge/gateway-AxonHub-0A7E8C.svg)](https://github.com/looplj/axonhub)

This plugin attaches identity request headers recognized by AxonHub to model requests sent from DeepSeek Harness (DSH).

Once installed and enabled, AxonHub's tracing view groups model calls by conversation thread and interaction turn instead of listing every request as an isolated record. Title generation and auto-approval requests stay out of the main conversation timeline, context compaction summaries are tagged as a distinct type, and subagent tasks are placed under their own dedicated traces.

## What Problem It Solves

By default, DSH sends model requests without any session identifiers. When the AxonHub gateway receives these requests, it treats each one as an isolated call: it cannot tell which requests belong to the same conversation, nor can it distinguish regular chat replies from title generation, auto-approval, or context compaction requests.

Using DSH's `llm-pi-ai/request-headers` hook, this plugin injects three HTTP request headers before each request is sent so AxonHub can identify and group them:

1. `AH-Thread-Id`: The conversation thread ID. Related requests within the same conversation share the same thread value.
2. `AH-Trace-Id`: The trace ID for a single conversation turn or task. Within a turn, this value remains constant regardless of how many tool calls or retries occur.
3. `AH-Kind`: The request type identifier, indicating to the gateway whether the request is a regular chat turn, subagent task, title generation, auto-approval, or compaction summary.

When AxonHub receives a request, it creates or links a conversation thread from `AH-Thread-Id` and a trace record from `AH-Trace-Id`. `AH-Kind` is recorded alongside the request headers so calls can be told apart by type.

## Installation

You can add this plugin package directly from the plugin management view in DSH, or install it from the command line with `dsh plugin --profile desktop add <path>` (replacing `<path>` with the actual plugin directory path):

```sh
dsh plugin --profile desktop add /path/to/dsh-axonhub-tracing
```

Restart DSH once after installation, and "AxonHub Tracing" (AxonHub 追踪) will appear in the plugin list.

## Settings

Open the Plugins page in DSH Settings and select "AxonHub Tracing" (AxonHub 追踪) to configure the plugin.

At the top of the page is the master toggle. Turning it off stops attaching the three headers starting from the next request, letting you pause tracing immediately without uninstalling the plugin.

Below the master toggle is the default channel scope setting, which governs channels that do not have an explicit per-channel override. Three modes are available:

1. Auto (自动): Attach headers only to channels whose name or endpoint URL contains `axon`.
2. All (全部): Attach headers to all supported channels.
3. Off (全关): Attach headers to no channels by default.

Below the default scope is the channel list, where per-channel manual toggles take precedence over the default scope. Checking a channel forces headers on for that channel; unchecking it forces headers off. Next to each channel, a label indicates whether its current state comes from the default scope or a manual override. Channels with a manual override show a "Restore default" (恢复默认) button on the right, which clears the override and returns the channel to the default scope rule. With this setup, newly added channels automatically follow the default scope without requiring plugin reconfiguration, and only channels that need special handling require manual overrides.

The bottom of the page displays the 20 most recent calls where headers were attached, showing the timestamp, request type, channel, and trace ID. This list is empty right after installation and populates once you send a chat message.

All settings are stored in the following local file, which can also be edited by hand:

```
~/.dsh/axonhub-tracing/settings.json
```

The settings file is owned by a single DSH process. If two DSH processes are running at the same time and both modify settings, the last write wins, and the other process must be restarted to pick up the updated values. If the settings file is corrupted, the plugin disables itself rather than silently resetting to defaults and continuing to attach headers; it resumes once the file is fixed or deleted and recreated.

## Grouping Rules

A thread represents a conversation, and a trace represents a single interaction turn or a specific task. By default, requests use the current session as their thread, and only specific request types are split into separate threads according to configuration:

1. Regular chat and turn tracing: "Turn tracing" (轮次追踪) is enabled by default for regular chat. Each turn generates a separate trace with a trace ID formatted as `<session>:t<turn>`. Within the same turn, the trace ID remains unchanged across any number of tool calls or retries. If you turn off "Turn tracing" (轮次追踪) in settings, the entire session shares a single trace ID, which makes it easier to view total session cost at the expense of per-turn separation. This toggle only controls the turn suffix on the trace ID and does not change the thread ID, so toggling it on or off does not affect session stickiness.
2. Compaction summaries: Context compaction summaries always share the current turn's trace. Because compaction requests operate on the same context as the active conversation, keeping them in the same trace preserves a continuous context history while still distinguishing them from regular calls via the kind header.
3. Titles and approvals: Title generation and auto-approval each have an independent setting, both defaulting to separate mode. In separate mode, their threads are `<session>#title` and `<session>#review`, and their traces are `<session>:title` and `<session>:review`, keeping them out of the main session timeline. Because title generation and approval requests do not share the main conversation context or its cache prefix anyway, splitting them into separate threads incurs no cache penalty. To merge either one back into the main session, switch its setting to follow the main session; the two toggles operate independently.
4. Subagents: Subagents use separate threads by default, with trace IDs formatted as `<parent-session>:c<name>.<short-code>:t<turn>` so the parent session, subagent name, and turn are immediately visible in the gateway UI. The `<short-code>` is derived from the child session ID, preventing ID collisions when a parent session launches two subagents with the same name concurrently. DSH automatically records the parent-child relationship on the child session, and the plugin reads it directly without extra configuration. When a subagent runs in a separate thread, upstream routing may assign it to a different channel; if sharing the prefix cache with the parent session is a higher priority, you can change the subagent setting to follow the parent session.

## Relationship with Caching

This plugin only sends identity headers on outgoing requests; it does not directly increase cache hit rates on its own. Channel pinning is controlled by AxonHub's channel stickiness setting, `trace_sticky_mode`.

When `trace_sticky_mode` is enabled on the gateway, AxonHub first checks which channel was last used for the same trace, and on a miss falls back to the channel last used for the same thread. Both mapping levels are cached for 30 minutes. Routing to the same channel means using the same upstream account, which is a prerequisite for prefix cache hits.

Depending on whether the plugin and gateway stickiness are enabled, there are three scenarios:

1. Plugin installed, gateway stickiness disabled: AxonHub records traces and usage accounting, while gateway channel selection behaves the same as before installation.
2. Gateway stickiness enabled, plugin not installed: No effect on DSH, because DSH sends neither trace IDs nor thread IDs by default, leaving the gateway with no identifier to pin against.
3. Both plugin and gateway stickiness enabled: Gateway routing stays pinned according to the identity headers carried by each request.

The second-level fallback is key to how this works. Because an entire main conversation shares a single thread ID, starting a new turn with a new trace ID (when turn tracing is enabled) still resolves to the previous channel via the thread lookup. The turn suffix does not break session stickiness, so default turn tracing will not scatter a conversation across different channels. Only requests split into separate threads, such as titles, approvals, and subagents in separate mode, can be routed to a different channel. For titles and approvals, the prompt prefix differs from the main conversation anyway, so switching channels has little impact; for subagents that share a prefix with the parent session, configuring them to follow the parent session keeps routing stable.

## Supported Channels

The plugin hooks into `llm-pi-ai/request-headers` and only covers channels routed through the `pi-ai` adapter. This includes a local AxonHub primary channel as well as manually configured `anthropic`, `google`, `openai`, or `kimi` channels pointed at a local gateway.

DSH's native DeepSeek endpoint and subscription account endpoints are not supported. Those two paths send only their own authentication headers and do not invoke the `llm-pi-ai/request-headers` extension hook in the underlying request pipeline, so the plugin cannot attach headers to them.

Unsupported channels never receive headers from this plugin and do not need to be manually disabled; for supported channels you want to trace, either let the default scope match them or check them manually in settings.

## Verification

After installation, you can verify that tracing is working as expected with the following steps:

1. Send a regular chat message and wait for the reply to finish.
2. Open the Traces page in AxonHub, confirm that a record for the current turn appears, and open it to verify that all model calls from that turn are grouped inside.
3. Check the Threads page in AxonHub and confirm that multiple turns from the same conversation are grouped under the same thread.
4. Start a new conversation to trigger automatic title generation, then check the thread list to confirm that a separate thread ending in `#title` appears with a title request type, without mixing into the regular chat thread.
5. Launch a subagent to run a task, then check the thread list to confirm that a separate subagent thread appears and that its trace ID reflects the parent session and subagent name.
6. Turn off the plugin's master toggle, send another message, and inspect the request headers via a packet capture tool or gateway logs to confirm that no headers starting with `AH` are present.

You can also use the recent requests list at the bottom of the plugin settings page for a quick check; it displays the request type and trace ID for each call that had headers attached.

## Development and Testing

This repository has no runtime dependencies. After cloning, run the test suite directly:

```sh
npm test
```

The tests cover ID derivation, channel selection, settings migration, atomic header injection, the recent requests list, and multi-process settings merging.

## Uninstallation

You can remove this plugin from the plugin management view in DSH, or run the `remove` command from the command line:

```sh
dsh plugin --profile desktop remove dsh-axonhub-tracing
```

The plugin does not write to any database or modify channel configurations. Once uninstalled, outgoing model request headers immediately return to their default state. Only the local settings file `~/.dsh/axonhub-tracing/settings.json` remains on disk; you can delete it manually if desired, or leave it in place without side effects.

## Known Limitations

1. Channel coverage: The plugin uses `llm-pi-ai/request-headers` and only covers channels routed through `pi-ai`. DSH's native DeepSeek endpoint and subscription account endpoints are not supported, and the plugin cannot intercept those requests.
2. External backend subagents: If a subagent runs on an external backend such as Claude Code or Codex, its requests bypass DSH's model layer and therefore will not carry headers from this plugin. This is expected behavior.
3. Privacy and identifier hashing: Trace IDs contain session IDs and subagent names, which are local structural identifiers and never include conversation content. If you prefer not to expose raw identifiers to the gateway, set `hashIds` to `true` in the settings file to replace all IDs with short hexadecimal hashes, with the trade-off that the original values will no longer be human-readable in the gateway UI. Note that the underlying model library may still send its own session identifiers under certain protocols; those identifiers are not written by this plugin and are not controlled by `hashIds`.

## Troubleshooting

1. Settings page shows "Channel list not loaded yet" (还没有读到渠道列表): The host has not finished registering channels yet. Send one message first, then reopen the settings page.
2. Settings page shows an error: The host plugin failed to load completely. Restart DSH once and verify that the plugin appears in the plugin list.
3. Requests appear in AxonHub but are not grouped: First confirm that the request headers include `AH-Trace-Id`. If the header is present and requests are still ungrouped, check whether `trace_header` in the gateway's tracing configuration was changed to a different header name.
4. Trace IDs do not advance per turn: Check whether "Turn tracing" (轮次追踪) is turned off in settings. When turned off, the entire conversation shares a single trace ID and appears unsplit across turns in the gateway UI.
