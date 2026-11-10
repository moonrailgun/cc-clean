// Synthetic wire data following openai/codex rust-v0.167.0; no user history.
export function modernSnapshot(window_number: number) {
  const source = {id: {message_id: 'message', turn_id: 'turn', role: 'user'}, revision: 'revision', complete: true};
  const sender = {receiver_turn_id: 'turn', receiver_message_id: 'message', text: 'Sender context'};
  const metadata = {
    guardian_sources: [source], guardian_review_ids: ['review'], guardian_source_order_guidance: true,
    guardian_retained_omissions: {user_instructions: false, assistant_context: true}, retained_source: source,
    mcp_attribution: {status: 'complete', sources: [{server_name: 'server', tool_name: 'tool',
      first_turn_id: 'turn', connector_id: 'connector', plugin_id: 'plugin'}]}, sender_user_messages: sender,
  };
  const passthrough = {
    turn_id: 'turn', create_time: 1234.5, content_item_kinds: ['user.text'],
    content_item_metadata: [
      ...['unknown', 'user_configured', 'skills', 'agents_md', 'user'].map(type => ({provenance: {type}})),
      {provenance: {type: 'developer_instructions', from_additional_requirements: true}},
      {provenance: {type: 'harness', hook: false}}, {provenance: {type: 'tool', namespace: 'custom'}},
      {harness_injected: true, source_tool_namespace: 'legacy'}, {},
    ],
    cell_id: 'cell', executed_tool_calls: [{name: 'tool', arguments: {arbitrary: [null, true]},
      tool_result_sources: [{type: 'connector', id: 'source'}], tool_result_metadata: {arbitrary: true}}],
    tool_calls_complete: true,
  };
  const content = [{type: 'input_text', text: 'Keep context'}, {type: 'input_image', file_id: 'file', detail: 'original'},
    {type: 'input_image', image_url: 'data:image/png;base64,AAAA'}, {type: 'input_audio', audio_url: 'audio'},
    {type: 'encrypted_content', encrypted_content: 'opaque'}];
  const history = [
    {type: 'message', role: 'user', content: [...content.slice(0, -1), {type: 'input_audio', file_id: 'audio-file'}]},
    {type: 'compaction', encrypted_content: 'opaque'},
    {type: 'agent_message', author: '/root', recipient: '/root/worker', content: [content[0], content[4]]},
    {type: 'function_call_output', output: content},
    {type: 'custom_tool_call_output', call_id: 'custom', output: content},
  ].map(item => ({...item, internal_chat_message_metadata_passthrough: passthrough}));
  const tool = {type: 'function', name: 'tool', description: 'Tool', inputSchema: {type: 'object'}, deferLoading: true};
  const message = {turn_id: 'turn', message_id: 'message', text: 'Retained text', complete: true,
    order: 0, revision: 'revision', inherited: false, origin: 'user', phase: 'final_answer'};
  return {type: 'compacted', payload: {
    message: `Summary ${window_number}`, window_number, window_id: `window-${window_number}`,
    replacement_history: [...history, {type: 'additional_tools', id: 'tools', role: 'developer', tools: [tool]}],
    replacement_history_metadata: [...history, {}].map(() => metadata),
    guardian_history: [{...history[0], guardian_metadata: metadata}, history[1]],
    retained_context: {verified_answers: [{turn_id: 'turn', call_id: 'call', order: 1,
      questions: [{question: 'Question', answer: 'Answer'}]}], incomplete: false,
      user_messages: [message], user_messages_incomplete: false, assistant_messages: [{...message, origin: 'heartbeat'}],
      assistant_messages_incomplete: false, next_order: 3, sender_deliveries: [{...sender, order: 2}]},
    mcp_resource_origins: {origins: [{call_id: 'call', turn_id: 'turn', tool: 'tool', connector_id: 'connector',
      link_id: 'link', uri: 'ui://widget', ambiguous_account: false}], turns: ['turn'], current_turn_id: 'turn'},
    resume_metadata: {dynamic_tools: {thread_id: '00000000-0000-0000-0000-000000000001',
      tools: [tool, {type: 'namespace', name: 'namespace', description: 'Tools', tools: [tool]}]},
      turn_attribution: {turn_id: 'turn', turn_trigger: 'user', parent_turn_id: 'parent',
        initiating_agent_path: '/root/worker', root_turn_id: 'root'}, multi_agent_version: 'v2', last_started_turn_id: 'turn',
      previous_turn_settings: {model: 'synthetic', cyber_access_program: 'daybreak_blue', comp_hash: 'hash', realtime_active: false}},
  }};
}
