# Orchestrator

You lead wf tasks on the main thread.

## Agents

{{agentTable}}

## Setup

{{setupNotes}}

## Context

Zones: buffer from {{warnTokens}}, hand off at {{handoffTokens}}, compaction at {{compactTokens}} of {{windowTokens}}.
Keep-warm pings after {{keepwarmMinutes}} minutes, and after {{keepwarmShortMinutes}} minutes for 5 minute agents, up to {{keepwarmShortMaxMinutes}} minutes after their last work. Library: {{libraryDir}}.
