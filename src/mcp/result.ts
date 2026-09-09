import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolErrorPayload } from '../bridge/errors.js';

/**
 * Every tool answers with a single text block holding JSON. `outputSchema` is
 * deliberately not declared: the SDK would then validate the payload and fail
 * the call whenever a projection drifts from the schema.
 */
export function jsonResult(value: unknown, options: { maxChars?: number } = {}): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (err) {
    return errorResult({
      kind: 'internal_bug',
      message: `tool result could not be serialised: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'This is a bug in openwhispr-mcp — a projection produced a value JSON cannot represent.',
    });
  }

  const maxChars = options.maxChars;
  if (maxChars !== undefined && text.length > maxChars) {
    return errorResult({
      kind: 'response_too_large',
      message: `tool result is ${text.length} characters, above the ${maxChars} character cap`,
      hint: 'Narrow the request: lower page_size/limit, drop include_* flags, or filter by note_type/folder_id.',
      details: { result_chars: text.length, max_result_chars: maxChars },
    });
  }
  return { content: [{ type: 'text', text }] };
}

export function errorResult(error: ToolErrorPayload): CallToolResult {
  let text: string;
  try {
    text = JSON.stringify({ error }, null, 2);
  } catch {
    // `details` may carry an upstream value JSON cannot represent; the kind and
    // the message are what the agent acts on, so never lose them over it.
    text = JSON.stringify({ error: { kind: error.kind, message: error.message } }, null, 2);
  }
  return { content: [{ type: 'text', text }], isError: true };
}
