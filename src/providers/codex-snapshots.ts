// The supported wire subset follows openai/codex rust-v0.167.0 history/rollout_payload.rs
// and protocol/models.rs. Unknown typed state must not make an invalid checkpoint look usable.
type Check = (value: any) => boolean;
const string: Check = value => typeof value === 'string';
const boolean: Check = value => typeof value === 'boolean';
const integer: Check = value => Number.isSafeInteger(value) && value >= 0;
const optional = (check: Check): Check => value => value == null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...values: unknown[]): Check => value => values.includes(value);
function shape(value: any, required: Record<string, Check>, extra: Record<string, Check> = {}): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(required).every(([key, check]) => check(value[key])) &&
    Object.keys(value).every(key => Object.hasOwn(required, key) || Object.hasOwn(extra, key) && extra[key](value[key]));
}
const absent = optional(() => false);
const optionalString = optional(string);
const text = (types: string[]): Check => value => shape(value, {type: oneOf(...types), text: string});
const content: Check = value => {
  if (value?.type === 'output_text') return shape(value, {type: oneOf('output_text'), text: string}, {
    annotations: optional(array(() => true)), logprobs: optional(array(() => true)),
  });
  if (value?.type === 'input_image') return shape(value, {type: oneOf('input_image')}, {
    image_url: string, file_id: string, detail: optional(oneOf('auto', 'low', 'high', 'original')),
  }) && (string(value.image_url) || string(value.file_id));
  return text(['input_text'])(value);
};
const common = {id: optionalString, internal_chat_message_metadata_passthrough: absent};
const responseItem: Check = value => {
  switch (value?.type) {
    case 'message': return shape(value, {type: string, role: string, content: array(content)}, {
      ...common, encrypted_content: optionalString, status: optionalString,
      phase: optional(oneOf('commentary', 'partial_answer', 'final_answer')),
    });
    case 'reasoning': return shape(value, {type: string, summary: array(text(['summary_text']))}, {
      ...common, encrypted_content: optionalString, content: optional(array(text(['reasoning_text', 'text']))),
    });
    case 'compaction': case 'compaction_summary':
      return shape(value, {type: string, encrypted_content: string}, common);
    case 'context_compaction': return shape(value, {type: string}, {...common, encrypted_content: optionalString});
    case 'function_call': return shape(value, {type: string, name: string, arguments: string, call_id: string}, {
      ...common, encrypted_content: optionalString, status: optionalString, namespace: optionalString,
      encrypted_function_args: optional(array(string)),
    });
    case 'custom_tool_call': return shape(value, {type: string, name: string, input: string, call_id: string}, {
      ...common, encrypted_content: optionalString, status: optionalString, namespace: optionalString,
    });
    case 'function_call_output': case 'custom_tool_call_output':
      // shortcut: structured tool outputs stay protected until their full wire schema is supported.
      return shape(value, {type: string, call_id: string, output: string}, {...common, name: optionalString, namespace: optionalString});
    default: return false;
  }
};
const metadata: Check = value => shape(value, {}, {
  guardian_sources: array(() => false), guardian_review_ids: array(string), guardian_source_order_guidance: boolean,
  guardian_retained_omissions: optional(value => shape(value, {user_instructions: boolean, assistant_context: boolean})),
  retained_source: absent, client_authored: boolean, fallback_token_limit_override: optional(integer),
  delivered_assistant_message: optionalString, harness_authored_configuration: boolean, compaction_model_hash: optionalString,
  user_input_order: optional(integer), compaction_output: boolean, inherited_user_message: boolean,
  mcp_attribution: absent, sender_user_messages: absent,
});
const resumeMetadata: Check = value => shape(value, {}, {
  // shortcut: complex resume/retained state stays protected until its native schema is supported.
  dynamic_tools: absent, turn_attribution: absent, multi_agent_version: optional(oneOf('disabled', 'v1', 'v2')),
  last_started_turn_id: optionalString,
  previous_turn_settings: optional(value => shape(value, {model: string}, {
    cyber_access_program: absent, comp_hash: optionalString, realtime_active: optional(boolean),
  })),
});
const uuid: Check = value => string(value) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const usage: Check = value => shape(value, {
  input_tokens: integer, cached_input_tokens: integer, output_tokens: integer,
  reasoning_output_tokens: integer, total_tokens: integer,
}, {cache_write_input_tokens: integer, codex_rollout_budget_units: optional(value => typeof value === 'number' && Number.isFinite(value))});
const usageRecord: Check = value => shape(value, {
  thread_id: uuid, turn_id: string, session_id: uuid, root_turn_id: string, response_id: string,
  usage, turn_token_usage: usage, thread_token_usage: usage,
});

export function knownCompactionSnapshot(row: any): boolean {
  if (!shape(row, {type: oneOf('compacted'), payload: value => shape(value, {message: string}, {
    replacement_history: optional(array(responseItem)), replacement_history_metadata: optional(array(metadata)),
    window_number: optional(integer), window_id: optional(value => string(value) || integer(value)),
    first_window_id: optionalString, previous_window_id: optionalString, compaction_response_id: optionalString,
    resume_metadata: optional(resumeMetadata), guardian_history: optional(array(() => false)),
    retained_context: absent, mcp_resource_origins: absent, latest_token_usage_record: optional(usageRecord),
  })}, {timestamp: string, ordinal: integer})) return false;
  const payload = row.payload;
  return payload.replacement_history_metadata == null ||
    Array.isArray(payload.replacement_history) && payload.replacement_history.length === payload.replacement_history_metadata.length;
}

export function completeCompactionSnapshot(row: any): boolean {
  return knownCompactionSnapshot(row) && Array.isArray(row.payload.replacement_history) &&
    (integer(row.payload.window_number) || integer(row.payload.window_id));
}
