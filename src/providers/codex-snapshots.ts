// The supported wire subset follows openai/codex rust-v0.167.0 history/rollout_payload.rs
// and protocol/models.rs. Unknown typed state must not make an invalid checkpoint look usable.
type Check = (value: any) => boolean;
const string: Check = value => typeof value === 'string';
const boolean: Check = value => typeof value === 'boolean';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const integer: Check = value => Number.isSafeInteger(value) && value >= 0;
const optional = (check: Check): Check => value => value == null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...values: unknown[]): Check => value => values.includes(value);
function shape(value: any, required: Record<string, Check>, extra: Record<string, Check> = {}): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(required).every(([key, check]) => check(value[key])) &&
    Object.keys(value).every(key => Object.hasOwn(required, key) || Object.hasOwn(extra, key) && extra[key](value[key]));
}
const optionalString = optional(string);
const uuid: Check = value => string(value) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
// Callers pass parsed JSON; open values are permitted only for native serde_json::Value fields.
const json: Check = value => value !== undefined;
const phase = optional(oneOf('commentary', 'partial_answer', 'final_answer'));
const text = (types: string[]): Check => value => shape(value, {type: oneOf(...types), text: string});
const content: Check = value => {
  if (value?.type === 'output_text') return shape(value, {type: oneOf('output_text'), text: string}, {
    annotations: optional(array(() => true)), logprobs: optional(array(() => true)),
  });
  if (value?.type === 'input_image') return shape(value, {type: oneOf('input_image')}, {
    image_url: string, file_id: string, detail: optional(oneOf('auto', 'low', 'high', 'original')),
  }) && (string(value.image_url) || string(value.file_id));
  if (value?.type === 'input_audio') return shape(value, {type: oneOf('input_audio')}, {
    audio_url: string, file_id: string,
  }) && (string(value.audio_url) || string(value.file_id));
  return text(['input_text'])(value);
};
const encrypted: Check = value => shape(value, {type: oneOf('encrypted_content'), encrypted_content: string});
const toolContent: Check = value => {
  if (value?.type === 'input_audio') return shape(value, {type: string, audio_url: string});
  return encrypted(value) || ['input_text', 'input_image'].includes(value?.type) && content(value);
};
const provenance: Check = value => {
  switch (value?.type) {
    case 'unknown': case 'user_configured': case 'skills': case 'agents_md': case 'user':
      return shape(value, {type: string});
    case 'developer_instructions': return shape(value, {type: string, from_additional_requirements: boolean});
    case 'harness': return shape(value, {type: string}, {hook: boolean});
    case 'tool': return shape(value, {type: string}, {namespace: optionalString});
    default: return false;
  }
};
const passthrough: Check = value => shape(value, {}, {
  turn_id: optionalString, create_time: optional(number), content_item_kinds: optional(array(string)),
  content_item_metadata: optional(array(value => shape(value, {}, {
    provenance: optional(provenance), harness_injected: optional(boolean), source_tool_namespace: optionalString,
  }))),
  cell_id: optionalString, tool_calls_complete: optional(boolean),
  executed_tool_calls: optional(array(value => shape(value, {name: string, arguments: json}, {
    tool_result_sources: optional(array(value => shape(value, {type: string, id: string}))), tool_result_metadata: json,
  }))),
});
const common = {id: optionalString, internal_chat_message_metadata_passthrough: optional(passthrough)};
const responseItem: Check = value => {
  switch (value?.type) {
    case 'message': return shape(value, {type: string, role: string, content: array(content)}, {
      ...common, encrypted_content: optionalString, status: optionalString,
      phase,
    });
    case 'agent_message': return shape(value, {type: string, author: string, recipient: string,
      content: array(value => text(['input_text'])(value) || encrypted(value))}, common);
    case 'additional_tools': return shape(value, {type: string, role: string, tools: array(json)}, {id: optionalString});
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
      return shape(value, {type: string, call_id: value.type === 'function_call_output' ? optionalString : string,
        output: value => string(value) || array(toolContent)(value)}, {
        ...common, name: optionalString, ...(value.type === 'function_call_output' ? {namespace: optionalString} : {}),
      });
    default: return false;
  }
};
const retainedSource: Check = value => shape(value, {
  id: value => shape(value, {message_id: string, turn_id: string, role: oneOf('user', 'assistant')}),
  revision: string, complete: boolean,
});
const senderFields = {receiver_turn_id: string, receiver_message_id: string, text: string};
const mcpAttribution: Check = value => shape(value, {status: oneOf('none', 'complete', 'attribution_error')}, {
  error_reason: optional(oneOf('history_missing_checkpoint', 'checkpoint_invalid', 'checkpoint_source_conflict',
    'source_invalid', 'recorder_poisoned', 'restored_error_unknown', 'payload_too_large', 'serialization_failed', 'unknown')),
  sources: array(value => shape(value, {server_name: string, tool_name: string, first_turn_id: string}, {
    connector_id: optionalString, plugin_id: optionalString,
  })),
});
const metadata: Check = value => shape(value, {}, {
  guardian_sources: array(retainedSource), guardian_review_ids: array(string), guardian_source_order_guidance: boolean,
  guardian_retained_omissions: optional(value => shape(value, {user_instructions: boolean, assistant_context: boolean})),
  retained_source: optional(retainedSource), client_authored: boolean, fallback_token_limit_override: optional(integer),
  delivered_assistant_message: optionalString, harness_authored_configuration: boolean, compaction_model_hash: optionalString,
  user_input_order: optional(integer), compaction_output: boolean, inherited_user_message: boolean,
  mcp_attribution: optional(mcpAttribution), sender_user_messages: optional(value => shape(value, senderFields)),
});
const guardianItem: Check = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const {guardian_metadata, ...item} = value;
  return optional(metadata)(guardian_metadata) && responseItem(item);
};
const ordered = {revision: optionalString, inherited: boolean, order: integer};
const retainedMessage: Check = value => shape(value, {turn_id: string, text: string, complete: boolean}, {
  ...ordered, message_id: optionalString, origin: oneOf('user', 'heartbeat'), phase,
});
const retainedContext: Check = value => shape(value, {
  verified_answers: array(value => shape(value, {turn_id: string, call_id: string,
    questions: array(value => shape(value, {question: string, answer: string}))}, ordered)), incomplete: boolean,
}, {
  user_messages: array(retainedMessage), user_messages_incomplete: boolean,
  assistant_messages: array(retainedMessage), assistant_messages_incomplete: boolean, next_order: integer,
  sender_deliveries: array(value => shape(value, senderFields, ordered)),
});
const mcpOrigins: Check = value => shape(value, {
  origins: array(value => shape(value, {call_id: string, tool: string, connector_id: string, uri: string}, {
    turn_id: optionalString, link_id: optionalString, ambiguous_account: boolean,
  })), turns: array(string),
}, {current_turn_id: optionalString});
const dynamicFunction: Check = value => shape(value, {
  type: oneOf('function'), name: string, description: string, inputSchema: json,
}, {deferLoading: boolean});
const dynamicTool: Check = value => dynamicFunction(value) || shape(value, {
  type: oneOf('namespace'), name: string, description: string, tools: array(dynamicFunction),
});
const agentPath: Check = value => string(value) && (value === '/morpheus' ||
  /^\/root(?:\/[a-z0-9_]+)*$/.test(value) && value.split('/').slice(2).every((part: string) => part !== 'root'));
const resumeMetadata: Check = value => shape(value, {}, {
  dynamic_tools: optional(value => shape(value, {thread_id: uuid, tools: array(dynamicTool)})),
  turn_attribution: optional(value => shape(value, {turn_id: string}, {
    turn_trigger: optionalString, parent_turn_id: optionalString, initiating_agent_path: optional(agentPath), root_turn_id: optionalString,
  })), multi_agent_version: optional(oneOf('disabled', 'v1', 'v2')),
  last_started_turn_id: optionalString,
  previous_turn_settings: optional(value => shape(value, {model: string}, {
    cyber_access_program: optional(oneOf('standard', 'daybreak_blue', 'daybreak_red')), comp_hash: optionalString, realtime_active: optional(boolean),
  })),
});
const usage: Check = value => shape(value, {
  input_tokens: integer, cached_input_tokens: integer, output_tokens: integer,
  reasoning_output_tokens: integer, total_tokens: integer,
}, {cache_write_input_tokens: integer, codex_rollout_budget_units: optional(number)});
const usageRecord: Check = value => shape(value, {
  thread_id: uuid, turn_id: string, session_id: uuid, root_turn_id: string, response_id: string,
  usage, turn_token_usage: usage, thread_token_usage: usage,
});

export function knownCompactionSnapshot(row: any): boolean {
  if (!shape(row, {type: oneOf('compacted'), payload: value => shape(value, {message: string}, {
    replacement_history: optional(array(responseItem)), replacement_history_metadata: optional(array(metadata)),
    window_number: optional(integer), window_id: optional(value => string(value) || integer(value)),
    first_window_id: optionalString, previous_window_id: optionalString, compaction_response_id: optionalString,
    resume_metadata: optional(resumeMetadata), guardian_history: optional(array(guardianItem)),
    retained_context: optional(retainedContext), mcp_resource_origins: optional(mcpOrigins), latest_token_usage_record: optional(usageRecord),
  })}, {timestamp: string, ordinal: integer})) return false;
  const payload = row.payload;
  return payload.replacement_history_metadata == null ||
    Array.isArray(payload.replacement_history) && payload.replacement_history.length === payload.replacement_history_metadata.length;
}

export function completeCompactionSnapshot(row: any): boolean {
  return knownCompactionSnapshot(row) && Array.isArray(row.payload.replacement_history) &&
    (integer(row.payload.window_number) || integer(row.payload.window_id));
}
