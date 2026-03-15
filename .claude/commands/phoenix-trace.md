---
description: Analyze a Phoenix trace for performance and quality insights
---

Run this command with trace id and project id to fetch trace data:

```bash
node scripts/phoenix/fetch-trace.js {{traceId}} --project {{project}} $ARGUMENTS
```

Then analyze the output with **codebase-aware recommendations**:

1. **What happened**: Summarize the agent's workflow — what was the user's request, which tools were called, what was the response

2. **Map spans to code**: Connect span names back to actual code paths:
   - Agent type spans (e.g., `learning`, `go1`, `messaging`) → look up their config in `app/core/agents/types.py` (`AgentTypeRegistry`)
   - Tool call spans → find the tool implementation in `app/tools/`
   - System prompt names → find the prompt file in `prompts/` (or `prompts/experts/`)

3. **Performance**: Identify bottlenecks — which spans took longest, are there unnecessary sequential calls that could be parallel

4. **Token efficiency**: For high token usage spans:
   - Read the specific system prompt file in `prompts/` and suggest concrete cuts
   - Check if context/conversation history is ballooning unnecessarily

5. **Slow spans**: For spans taking >5s:
   - Identify the code path (tool execute method, LLM call, external API)
   - Suggest specific optimization (caching, parallel execution, prompt reduction)

6. **Errors**: For any errors:
   - Trace to the handler code in the codebase and suggest a fix
   - Check if it's a known pattern (rate limit, timeout, auth)

7. **Recommendations**: Give 2-3 specific improvements as "change X in file Y" — not generic advice. Reference specific files and line numbers.

Use `/phoenix-span <span_id>` to drill into the full prompt/response content of any specific span if needed.
