---
description: Fetch full detail for a specific Phoenix span (prompts, responses)
---

Run this command with span id and project id to fetch the full span data:

```bash
node scripts/phoenix/fetch-span.js {{spanId}} --project {{project}} $ARGUMENTS
```

This returns the complete span including full prompt content and API response. Analyze with **codebase awareness**:

1. **Prompt analysis**: Compare the prompt content against the source prompt file in `prompts/` (or `prompts/experts/`):
   - Are there differences from what's in the codebase? (runtime modifications, template variables)
   - Is the prompt bloated with unnecessary instructions?
   - Suggest specific edits to the prompt file to improve quality

2. **Tool call validation**: If the span contains tool calls:
   - Find the tool in `app/tools/` and check if parameters match the tool's `get_parameters()` definition
   - Assess whether the right tool was chosen for the task

3. **Response quality**: Assess whether the LLM output suggests prompt improvements:
   - Is the response on-topic and useful?
   - Does it follow the prompt's instructions?
   - If quality is poor, suggest specific prompt changes in the source file

4. **Message history**: Check if the input message array is growing excessively across turns — suggest where conversation trimming should happen in the code
