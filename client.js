/**
 * dsh-mattermost — Client half.
 *
 * The plugin's settings page under the sidebar's Plugins entry
 * (`plugins.bundle.config`): Mattermost environments (server, token, session,
 * triggers, scope, greeting) plus the shared behavior, reply texts and
 * diagnostics. Values are read and written through `ctx.configForms`, so a
 * save lands in the profile's cordis.patch.yml and reaches the Host's
 * volatile Config live. Writes are fine-grained path operations: tokens are
 * never sent back to the page, so an edit must not rewrite an environment
 * wholesale.
 *
 * Live status, "test connection", the session list and reconnect come from
 * the Host half's authenticated `/api/dsh-mattermost/<entry>/…` routes.
 *
 * Plain classic script in the client module loader's lazy factory format; no
 * build step, React comes from the page's module table. Styles copy the host
 * settings-form primitives under a `dshmm-` prefix and use theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mattermost',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React

    const PKG = 'dsh-mattermost'
    const ROW = 'mattermost'
    const NS = 'dshMattermost'
    const C = 'dshmm'

    // Keep in sync with lib/core.js and lib/config.js (test/client.test.js checks).
    const DEFAULT_MESSAGES = {
      queued: 'Your request has been queued. Please wait...',
      queueFull: 'The agent is busy, please try again later.',
      processing: 'Processing your request...',
      error: 'Sorry, an error occurred while processing your request.',
      empty: 'Empty message after removing the mention.',
      unauthorized: 'You do not have permission to use this agent.',
      cancelled: 'The request was cancelled in DSH.',
      timeout: 'Timed out waiting for DSH to reply.',
      noReply: 'DSH finished without a text reply.',
      noSession: 'No DSH session is bound to this bot yet. Run `/mattermost bind` in the DSH session that should answer.',
      waitingApproval: 'Waiting for a permission approval in DSH: `{tool}`',
      waitingAnswer: 'Waiting for an answer in DSH: {question}',
      stopped: 'The DSH bridge stopped before the request finished.',
    }
    const DEFAULT_PROMPT_HEADER = '[Mattermost] Message from @{user} in {channel}. Your final answer will be posted back to the Mattermost thread.'
    const CONNECTION_DEFAULTS = {
      name: '', serverUrl: '', sessionId: '', mentionName: '', triggerPattern: '', triggerPatternFlags: 'i',
      greetingChannelId: '', greetingMessage: '', goodbyeMessage: '',
      enabled: true, routeToAllMatches: false, triggerOnMention: true, triggerOnDirectMessage: true, followThreads: false, matchMentionsList: false, greetingEnabled: false,
    }
    const ROUTE_DEFAULTS = {
      id: '', mentionName: '', workspace: '', sessionMode: 'shared', sessionId: '',
      triggerOnMention: true, channels: [], allowedUsers: [], triggerOnDirectMessage: false, followThreads: false,
      matchMentionsList: false, triggerPattern: '', triggerPatternFlags: 'i',
    }
    const ROUTE_TRIGGER_FIELDS = ['triggerOnMention', 'triggerOnDirectMessage', 'followThreads', 'matchMentionsList', 'triggerPattern', 'triggerPatternFlags']
    const SESSION_MODES = ['shared', 'thread', 'new']
    const SHARED_DEFAULTS = {
      workspace: '', sessionTitle: 'Mattermost', promptHeader: DEFAULT_PROMPT_HEADER, stateFile: '', debugLogFile: '',
      autoCreateSession: true, ignoreBots: true, mentionSender: true, typingIndicator: true, showHost: false,
      threadContextMaxMessages: 20, queueMaxSize: 10, replyTimeoutMinutes: 60, maxPostLength: 16000, maxConcurrent: 3, replyMode: 'final',
    }
    // Legacy connection-level mention/session/trigger fields remain in the Host schema only for old profiles.
    const CONNECTION_TEXT = ['name', 'serverUrl', 'greetingChannelId', 'greetingMessage', 'goodbyeMessage']
    const CONNECTION_BOOL = ['enabled', 'routeToAllMatches', 'greetingEnabled']
    const CONNECTION_LIST = ['channels', 'allowedUsers']
    const ROUTE_TEXT = ['mentionName', 'workspace', 'sessionId', 'triggerPattern', 'triggerPatternFlags']
    const ROUTE_LIST = ['channels', 'allowedUsers']
    const ROUTE_BOOL = ['triggerOnDirectMessage', 'followThreads', 'matchMentionsList']
    const SHARED_TEXT = ['workspace', 'sessionTitle', 'promptHeader', 'stateFile', 'debugLogFile']
    const SHARED_BOOL = ['autoCreateSession', 'ignoreBots', 'mentionSender', 'typingIndicator', 'showHost']
    const SHARED_NUMBER = { maxConcurrent: { min: 1, integer: true }, threadContextMaxMessages: { min: 0, integer: true }, queueMaxSize: { min: 0, integer: true }, replyTimeoutMinutes: { min: 0, integer: false }, maxPostLength: { min: 1000, integer: true } }

    const zh = {
      intro: '每个环境对应一个 Mattermost 服务器和一个机器人账号；在环境里添加路由，可以让不同的 @名称 由不同的 DSH 工作区回答。保存后立即生效。',
      environments: 'Mattermost 环境',
      addEnvironment: '添加环境',
      noEnvironments: '还没有环境。点击“添加环境”，填写服务器地址和机器人令牌。',
      untitledEnvironment: '未命名环境',
      edit: '编辑',
      collapse: '收起',
      enabledLabel: '启用此环境',
      name: '名称',
      nameHint: '用于区分环境，例如“公司”或“本地测试”。',
      serverUrl: '服务器地址',
      serverUrlHint: '例如 https://mattermost.example.com；不写协议时默认 https。',
      token: '访问令牌',
      tokenHint: '机器人账号（或个人访问令牌）的 Token。已保存的令牌不会显示；留空表示保持不变。',
      tokenSaved: '已保存',
      tokenMissing: '未设置',
      tokenPlaceholder: '输入新令牌',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接成功：已登录为 @{user}',
      testFailed: '连接失败：{error}',
      testUnavailable: '无法测试：{error}',
      session: '处理消息的 DSH 会话',
      sessionAuto: '自动：使用 /mattermost bind 绑定的会话，没有则在工作区中自动新建',
      sessionHint: '选择一个会话后，这条路由的消息都交给它处理。',
      sessionNotListed: '（不在列表中）',
      sessionsUnavailable: '无法读取会话列表，请直接填写会话 ID。',
      untitledSession: '未命名会话',
      refresh: '刷新',
      currentBinding: '当前：{session}（由 /mattermost bind 绑定或自动创建）',
      currentAuto: '当前：收到第一条消息时在工作区中新建会话',
      currentNone: '当前：没有会话，请在要负责回复的会话中运行 /mattermost bind',
      currentThread: '每个消息串第一次提问时新建会话，串内追问继续使用它',
      currentNew: '每条消息都新建一个会话',
      routes: '路由：@名称 → 工作区',
      routesHint: '同一个 bot 使用多条 route，各自选择工作区、会话和触发条件。默认只处理一条：明确 @提及（消息中靠前者）→ 私聊 → 服务器提及 → 正则 → 无 @ 的消息串追问；同级先选原消息串的 route，再按列表顺序。',
      noRoutes: '未配置路由：@{bot} 的消息在一个共享会话中处理；旧环境的范围限制仍生效。添加第一条路由即可在路由里编辑范围，并继承旧触发规则。',
      routeToAllMatches: '同时分发给所有匹配的路由',
      routeToAllMatchesHint: '开启后，每条路由独立判断自己的触发条件；一条消息可触发多条路由，每条各处理一次并以 [@路由名] 标记回复。关闭时只由优先级最高的一条回答。',
      addRoute: '添加路由',
      duplicateRoute: '复制',
      duplicateRouteHint: '复制会保留工作区、会话模式及触发条件；生成新的 @名称和 ID，不复制固定会话，避免误用原路由的会话。',
      routeExpand: '展开',
      routeCollapse: '收起',
      routeInvalid: '配置有误',
      removeRoute: '删除路由',
      routeMention: '@名称',
      routeMentionHint: '提及这个 @名称就会由此路由回答，无需额外开关；填写时不含 @。留空使用机器人用户名，名称不必是 Mattermost 中的真实账号。',
      routeWorkspace: '工作区目录',
      routeWorkspaceHint: '从当前 DSH 已配置的工作区中选择；留空时使用通用设置中的默认工作区。',
      routeWorkspaceKnown: 'DSH 工作区：{title}',
      routeWorkspaceNew: '原有目录不在当前 DSH 工作区列表中；保留它不会改变配置，也可以改选已配置的工作区。',
      workspaceFirst: '自动：使用 DSH 的第一个工作区',
      workspaceInherit: '使用通用设置中的默认工作区',
      workspaceUnlisted: '当前值未在 DSH 工作区列表中：{path}',
      workspacesLoading: '正在获取 DSH 工作区列表…',
      workspacesUnavailable: '无法获取工作区列表，请点“刷新”重试。',
      workspacesEmpty: 'DSH 尚无已配置的工作区，请先在 DSH 中添加工作区。',
      sessionMode: '会话模式',
      modeShared: '同一个会话：所有请求都在一个会话中处理',
      modeThread: '每个消息串一个新会话：串内追问继续使用它',
      modeNew: '每条消息一个新会话',
      tagShared: '同一会话',
      tagThread: '每串新会话',
      tagNew: '每条新会话',
      duplicateMention: '其他路由已使用这个 @名称',
      invalidMention: '只能包含字母、数字和 . _ -',
      triggers: '其他触发方式',
      routeTriggerHint: '@提及路由名称始终生效。以下条件只属于此路由；私聊/服务器提及可在多条路由中开启。',
      onDirect: '私聊 bot 时由此路由回复',
      followThreads: '此路由回复过的消息串里，后续消息无需再 @',
      matchMentionsList: '此路由同时信任服务器的提及列表',
      matchMentionsListHint: '包含 @channel、@all 等群体提及，一般不需要开启。',
      pattern: '自定义匹配（正则表达式 / flags）',
      patternHint: '例如 ^!ask\\s+(?<prompt>[\\s\\S]+)，命名分组 prompt 只把提问内容交给此路由；flags 中 i 表示不区分大小写（g/y 会忽略）。多个正则同时匹配时，遵循上方单路由优先级或全部分发开关。',
      patternFlags: 'Regex flags',
      scope: '范围',
      scopeRestricted: '范围受限',
      channels: '只监听这些频道',
      channelsHint: '频道 ID、名称或显示名，逗号分隔；留空表示机器人加入的所有频道。',
      allowedUsers: '只允许这些用户',
      allowedUsersHint: '用户名，逗号分隔；留空表示所有人。',
      greeting: '上线 / 下线通知',
      greetingEnabled: '连接时发送上线消息，断开时发送下线消息',
      greetingChannelId: '通知频道 ID',
      greetingMessage: '上线消息',
      goodbyeMessage: '下线消息',
      defaultText: '默认：{text}',
      reconnect: '重新连接',
      remove: '删除此环境',
      stateConnected: '已连接',
      stateConnectedAs: '已连接 @{bot}',
      stateConnecting: '连接中',
      stateReconnecting: '重连中',
      stateAuthFailed: '令牌无效',
      stateError: '连接出错',
      stateUnconfigured: '缺少地址或令牌',
      stateDisabled: '已停用',
      stateStarting: '启动中',
      stateUnsaved: '未保存',
      stateUnknown: '状态未知',
      lastError: '最近错误：{error}',
      shared: '通用设置',
      sharedHint: '对所有环境生效。',
      autoCreateSession: '共享会话模式下，没有指定或绑定会话时自动新建',
      workspace: '默认工作区目录',
      workspaceHint: '从当前 DSH 已配置的工作区中选择；没有设置工作区的路由会在此工作区新建会话。留空时使用第一个工作区。',
      sessionTitle: '新建会话的标题前缀',
      sessionTitleHint: '会自动加上路由名称，例如“Mattermost · @orion-agent”。',
      maxConcurrent: '同时处理的请求数',
      maxConcurrentHint: '不同路由、不同消息串或新会话可以并行处理；同一个共享会话或消息串内的请求始终按顺序处理。',
      replyMode: '回复内容',
      replyModeFinal: '本轮最后一条助手消息',
      replyModeAll: '本轮全部助手消息',
      replyTimeoutMinutes: '回复超时（分钟）',
      replyTimeoutMinutesHint: '超过后不再等待（DSH 中的任务仍会继续）；0 表示一直等待。',
      threadContextMaxMessages: '消息串上下文条数',
      threadContextMaxMessagesHint: '在消息串中提问时附带的历史消息数，0 表示不附带。',
      queueMaxSize: '排队上限',
      queueMaxSizeHint: '每个环境最多排队等待的请求数，超出的会被拒绝。',
      maxPostLength: '单条帖子最大长度',
      maxPostLengthHint: '超过时拆成多条发布，最小 1000。',
      mentionSender: '回复时 @提问者',
      typingIndicator: '处理时在消息串中显示“正在输入”',
      showHost: '在每条消息末尾附加主机名',
      ignoreBots: '忽略机器人账号和 Webhook 发的消息',
      promptHeader: '发给 DSH 的提示首行',
      promptHeaderHint: '可用 {user}、{channel}；清空表示不加首行。',
      resetDefault: '恢复默认',
      messages: '回复文案',
      messagesHint: '机器人在 Mattermost 中发送的提示语，留空使用默认文案。',
      show: '展开',
      hide: '收起',
      'message.queued': '已排队',
      'message.queueFull': '队列已满',
      'message.processing': '正在处理',
      'message.error': '处理出错',
      'message.empty': '消息为空',
      'message.unauthorized': '无权限',
      'message.cancelled': '在 DSH 中被取消',
      'message.timeout': '等待超时',
      'message.noReply': '没有文字回复',
      'message.noSession': '未绑定会话',
      'message.waitingApproval': '等待审批（可用 {tool}）',
      'message.waitingAnswer': '等待回答（可用 {question}）',
      'message.stopped': '桥接已停止',
      advanced: '诊断',
      debugLogFile: '调试日志文件',
      debugLogFileHint: '填写后把诊断日志追加到该文件；也可在会话中运行 /mattermost log 查看最近日志。',
      stateFile: '绑定记录文件',
      stateFileHint: '/mattermost bind 的绑定记录位置，留空为 ~/.dsh/mattermost/state.json。',
      save: '保存',
      discard: '放弃修改',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败：配置可能已在别处修改，请重试',
      invalid: '有字段填写不正确，请检查标红的项',
      unsaved: '有未保存的修改',
      loading: '正在读取配置…',
      unavailable: '当前无法编辑配置：请确认插件已启用，或直接编辑 profile 的 cordis.patch.yml',
      invalidUrl: '地址格式不正确',
      invalidPattern: '正则表达式无效',
      invalidFlags: '只能包含 d g i m s u v y',
      invalidNumber: '请输入有效的数字',
      tooSmall: '不能小于 {min}',
      commandsHint: '在任意 DSH 会话中运行 /mattermost 查看状态；/mattermost bind <环境> 把当前会话绑定给某个环境。',
    }
    const en = {
      intro: 'Each environment is one Mattermost server and one bot account; add routes to have different @names answered by different DSH workspaces. Saving applies immediately.',
      environments: 'Mattermost environments',
      addEnvironment: 'Add environment',
      noEnvironments: 'No environment yet. Click "Add environment" and enter the server URL and the bot token.',
      untitledEnvironment: 'Untitled environment',
      edit: 'Edit',
      collapse: 'Collapse',
      enabledLabel: 'Enable this environment',
      name: 'Name',
      nameHint: 'Tells environments apart, e.g. "Company" or "Local test".',
      serverUrl: 'Server URL',
      serverUrlHint: 'For example https://mattermost.example.com; https is assumed without a scheme.',
      token: 'Access token',
      tokenHint: 'Token of the bot account (or a personal access token). A saved token is never shown; leave empty to keep it.',
      tokenSaved: 'Saved',
      tokenMissing: 'Not set',
      tokenPlaceholder: 'Enter a new token',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected: signed in as @{user}',
      testFailed: 'Connection failed: {error}',
      testUnavailable: 'Cannot test: {error}',
      session: 'DSH session that answers',
      sessionAuto: 'Automatic: the session bound with /mattermost bind, otherwise a new one in the workspace',
      sessionHint: 'Pick a session to have it answer every message of this route.',
      sessionNotListed: '(not in the list)',
      sessionsUnavailable: 'The session list is unavailable; enter a session ID.',
      untitledSession: 'Untitled session',
      refresh: 'Refresh',
      currentBinding: 'Now: {session} (bound with /mattermost bind or created automatically)',
      currentAuto: 'Now: a session will be created in the workspace on the first message',
      currentNone: 'Now: no session; run /mattermost bind in the session that should answer',
      currentThread: 'The first request of each thread creates a session; follow-ups in the thread reuse it',
      currentNew: 'Every message creates a new session',
      routes: 'Routes: @name → workspace',
      routesHint: 'One bot has separate routes, each with its own workspace, session and triggers. By default one route answers: explicit @mention (earliest in the post) → DM → server mentions → regex → thread follow-up. At equal priority, prefer the thread’s route, then route order.',
      noRoutes: 'No routes: @{bot} uses one shared session; legacy environment scope still applies. Add a route to edit its scope and carry over legacy triggers.',
      routeToAllMatches: 'Deliver to every matching route',
      routeToAllMatchesHint: 'Each route evaluates its own triggers. One post can reach multiple routes; each answers once, labeled [@route-name]. Off: only the highest-priority route answers.',
      addRoute: 'Add route',
      duplicateRoute: 'Duplicate',
      duplicateRouteHint: 'Copies the workspace, session mode and triggers, but generates a new @name and ID; the pinned session is cleared so the copy cannot accidentally use the original route’s session.',
      routeExpand: 'Expand',
      routeCollapse: 'Collapse',
      routeInvalid: 'Invalid',
      removeRoute: 'Remove route',
      routeMention: '@name',
      routeMentionHint: 'Mentioning this @name always routes the post here; no extra switch is needed. Enter it without @; empty uses the bot username. It need not be a real Mattermost account.',
      routeWorkspace: 'Workspace directory',
      routeWorkspaceHint: 'Choose from the current DSH workspaces; empty uses the shared default workspace.',
      routeWorkspaceKnown: 'DSH workspace: {title}',
      routeWorkspaceNew: 'The saved directory is not in the current DSH workspace list; leaving it unchanged preserves it, or choose a registered workspace.',
      workspaceFirst: 'Automatic: use the first DSH workspace',
      workspaceInherit: 'Use the shared default workspace',
      workspaceUnlisted: 'Current value is not in the DSH workspace list: {path}',
      workspacesLoading: 'Loading DSH workspaces…',
      workspacesUnavailable: 'Could not load workspaces; select Refresh to retry.',
      workspacesEmpty: 'No workspaces configured in DSH yet. Add a workspace in DSH first.',
      sessionMode: 'Session mode',
      modeShared: 'One session: every request in the same session',
      modeThread: 'New session per thread: follow-ups in the thread reuse it',
      modeNew: 'New session for every message',
      tagShared: 'one session',
      tagThread: 'session per thread',
      tagNew: 'session per message',
      duplicateMention: 'Another route already uses this @name',
      invalidMention: 'Only letters, digits and . _ - are allowed',
      triggers: 'Other triggers',
      routeTriggerHint: '@mentions of the route name always work. These extra triggers belong only to this route; DMs and server mentions can be enabled on several routes.',
      onDirect: 'Answer direct messages through this route',
      followThreads: 'In threads this route answered, follow-ups need no new mention',
      matchMentionsList: 'Also trust the server mention list on this route',
      matchMentionsListHint: 'It includes group mentions such as @channel and @all; usually off.',
      pattern: 'Custom match (regular expression / flags)',
      patternHint: 'For example ^!ask\\s+(?<prompt>[\\s\\S]+): the named prompt group sends only the question to this route. Flag i ignores case (g/y are ignored). Overlapping regexes use the priority or all-matches setting above.',
      patternFlags: 'Regex flags',
      scope: 'Scope',
      scopeRestricted: 'Scoped',
      channels: 'Only these channels',
      channelsHint: 'Channel ids, names, or display names, comma separated; empty means every channel the bot joined.',
      allowedUsers: 'Only these users',
      allowedUsersHint: 'Usernames, comma separated; empty means everyone.',
      greeting: 'Online / offline notice',
      greetingEnabled: 'Post a greeting when connected and a goodbye when stopped',
      greetingChannelId: 'Notice channel ID',
      greetingMessage: 'Greeting',
      goodbyeMessage: 'Goodbye',
      defaultText: 'Default: {text}',
      reconnect: 'Reconnect',
      remove: 'Remove environment',
      stateConnected: 'Connected',
      stateConnectedAs: 'Connected @{bot}',
      stateConnecting: 'Connecting',
      stateReconnecting: 'Reconnecting',
      stateAuthFailed: 'Token rejected',
      stateError: 'Connection error',
      stateUnconfigured: 'Missing URL or token',
      stateDisabled: 'Disabled',
      stateStarting: 'Starting',
      stateUnsaved: 'Not saved',
      stateUnknown: 'Status unknown',
      lastError: 'Last error: {error}',
      shared: 'Shared settings',
      sharedHint: 'Apply to every environment.',
      autoCreateSession: 'One-session routes: create a session when none is selected or bound',
      workspace: 'Default workspace directory',
      workspaceHint: 'Choose from the current DSH workspaces. Routes without a workspace create sessions here; empty uses the first workspace.',
      sessionTitle: 'Title prefix of created sessions',
      sessionTitleHint: 'The route name is appended, e.g. "Mattermost · @orion-agent".',
      maxConcurrent: 'Requests at the same time',
      maxConcurrentHint: 'Different routes, threads or new sessions run in parallel; requests of one shared session or thread always run in order.',
      replyMode: 'Reply content',
      replyModeFinal: 'Last assistant message of the turn',
      replyModeAll: 'Every assistant message of the turn',
      replyTimeoutMinutes: 'Reply timeout (minutes)',
      replyTimeoutMinutesHint: 'Stop waiting afterwards (the DSH turn continues); 0 waits forever.',
      threadContextMaxMessages: 'Thread context messages',
      threadContextMaxMessagesHint: 'Earlier thread posts sent with a thread reply; 0 sends none.',
      queueMaxSize: 'Queue limit',
      queueMaxSizeHint: 'Requests per environment that may wait; more are rejected.',
      maxPostLength: 'Maximum post length',
      maxPostLengthHint: 'Longer answers are split into several posts; at least 1000.',
      mentionSender: 'Start replies with @sender',
      typingIndicator: 'Show "is typing" in the thread while working',
      showHost: 'Append the host name to every post',
      ignoreBots: 'Ignore posts from bot accounts and webhooks',
      promptHeader: 'First line of the prompt sent to DSH',
      promptHeaderHint: 'Use {user} and {channel}; empty sends no header line.',
      resetDefault: 'Reset to default',
      messages: 'Reply texts',
      messagesHint: 'What the bot posts in Mattermost; empty uses the default text.',
      show: 'Show',
      hide: 'Hide',
      'message.queued': 'Queued',
      'message.queueFull': 'Queue full',
      'message.processing': 'Processing',
      'message.error': 'Error',
      'message.empty': 'Empty message',
      'message.unauthorized': 'Not allowed',
      'message.cancelled': 'Cancelled in DSH',
      'message.timeout': 'Timed out',
      'message.noReply': 'No text reply',
      'message.noSession': 'No session bound',
      'message.waitingApproval': 'Waiting for approval ({tool} available)',
      'message.waitingAnswer': 'Waiting for an answer ({question} available)',
      'message.stopped': 'Bridge stopped',
      advanced: 'Diagnostics',
      debugLogFile: 'Debug log file',
      debugLogFileHint: 'Append diagnostic lines to this file; /mattermost log in a session also shows recent lines.',
      stateFile: 'Binding file',
      stateFileHint: 'Where /mattermost bind stores bindings; empty means ~/.dsh/mattermost/state.json.',
      save: 'Save',
      discard: 'Discard changes',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed: the configuration may have changed elsewhere; try again',
      invalid: 'Some fields are invalid; check the ones marked in red',
      unsaved: 'Unsaved changes',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is not editable right now: make sure the plugin is enabled, or edit the profile cordis.patch.yml',
      invalidUrl: 'Not a valid URL',
      invalidPattern: 'Not a valid regular expression',
      invalidFlags: 'Only d g i m s u v y are allowed',
      invalidNumber: 'Enter a valid number',
      tooSmall: 'Must be at least {min}',
      commandsHint: 'Run /mattermost in any DSH session to see the status; /mattermost bind <environment> binds the current session to an environment.',
    }

    const CSS = `
.${C}-root { display: flex; flex-direction: column; gap: 28px; }
.${C}-intro { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.${C}-section { display: flex; flex-direction: column; }
.${C}-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.${C}-section-title { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${C}-group-title { margin: 16px 0 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.${C}-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.${C}-field + .${C}-field, .${C}-field + .${C}-toggle, .${C}-toggle + .${C}-field, .${C}-toggle + .${C}-toggle { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${C}-head { display: flex; align-items: center; gap: 8px; }
.${C}-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${C}-input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${C}-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.${C}-input:disabled { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: default; }
.${C}-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.${C}-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary)); }
textarea.${C}-input { height: auto; min-height: 60px; padding: 8px 12px; resize: vertical; }
.${C}-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${C}-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.${C}-ok { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-success-primary); }
.${C}-toggle { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.${C}-toggle-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.${C}-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); cursor: pointer; }
.${C}-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.${C}-switch:disabled { cursor: default; opacity: 0.5; }
.${C}-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${C}-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }
.${C}-switch[aria-checked='false'] .${C}-thumb { background: var(--dsw-alias-switch-thumb, #fff); }
.${C}-switch[aria-checked='true'] .${C}-thumb { transform: translateX(16px); }
.${C}-card { display: flex; flex-direction: column; padding: 12px 16px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1); }
.${C}-card + .${C}-card { margin-top: 12px; }
.${C}-card-head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.${C}-card-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.${C}-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.${C}-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${C}-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.${C}-dot[data-tone='ok'] { background: var(--dsw-alias-state-success-primary); }
.${C}-dot[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary); }
.${C}-dot[data-tone='error'] { background: var(--dsw-alias-state-error-primary); }
.${C}-tag { display: inline-flex; align-items: center; flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 17px; white-space: nowrap; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary); }
.${C}-tag[data-tone='ok'] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.${C}-tag[data-tone='warn'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.${C}-tag[data-tone='error'] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
.${C}-body { display: flex; flex-direction: column; margin-top: 8px; padding-top: 4px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${C}-row { display: flex; align-items: center; gap: 8px; }
.${C}-row > .${C}-input { flex: 1; }
.${C}-row > .${C}-input.${C}-regex-flags { flex: 0 0 76px; width: 76px; padding: 0 8px; text-align: center; }
.${C}-route { display: flex; flex-direction: column; margin-top: 8px; padding: 4px 12px 4px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, transparent); }
.${C}-route-head { display: flex; align-items: center; gap: 8px; min-height: 36px; padding-top: 4px; cursor: pointer; }
.${C}-route-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; padding: 4px 0; background: transparent; text-align: left; font: inherit; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.${C}-route-name:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary))); outline-offset: 2px; }
.${C}-chevron { display: inline-block; margin-right: 8px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; padding: 3px; transform: rotate(-45deg); transition: transform 120ms ease; }
[aria-expanded='true'] > .${C}-chevron { transform: rotate(45deg); }
.${C}-route-body { display: flex; flex-direction: column; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${C}-routes-foot { display: flex; align-items: center; gap: 8px; padding: 10px 0 4px; }
.${C}-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${C}-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex: none; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 6px); background: transparent; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.${C}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.${C}-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 1px; }
.${C}-button:disabled { cursor: not-allowed; opacity: 0.4; }
.${C}-button[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }
.${C}-button[data-variant='quiet'] { border-color: transparent; color: var(--dsw-alias-label-secondary); }
.${C}-empty { margin: 0; padding: 16px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.${C}-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${C}-footer-text { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.${C}-footer-text[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.${C}-footer-text[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.${C}-save { appearance: none; padding: 5px 14px; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1)); font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.${C}-save:disabled { opacity: 0.4; cursor: default; }
.${C}-save:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))); outline-offset: 1px; }
`

    // ---------------------------------------------------------------- model

    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    const splitList = (text) => String(text ?? '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean)
    const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (whole, key) => (Object.hasOwn(values, key) ? String(values[key]) : whole))

    function slug(text) {
      return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    }

    function hostOf(serverUrl) {
      const raw = typeof serverUrl === 'string' ? serverUrl.trim() : ''
      if (raw === '') return ''
      try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
      } catch {
        return ''
      }
    }

    /** Same derivation as the Host's lib/config.js `connectionKeys`. */
    function connectionKeys(list) {
      const used = new Set()
      return (Array.isArray(list) ? list : []).map((entry, index) => {
        const item = isObject(entry) ? entry : {}
        const explicit = typeof item.id === 'string' ? item.id.trim() : ''
        const base = explicit || slug(item.name) || slug(hostOf(item.serverUrl)) || `connection-${index + 1}`
        let key = base
        for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`
        used.add(key)
        return key
      })
    }

    const mentionOf = (value) => String(value ?? '').trim().replace(/^@+/, '')

    /** Same derivation as the Host's lib/config.js `routeKeys`. */
    function routeKeys(list) {
      const used = new Set()
      return (Array.isArray(list) ? list : []).map((entry, index) => {
        const item = isObject(entry) ? entry : {}
        const explicit = typeof item.id === 'string' ? item.id.trim() : ''
        const base = explicit || slug(mentionOf(item.mentionName)) || `route-${index + 1}`
        let key = base
        for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`
        used.add(key)
        return key
      })
    }

    function routeForm(raw, key, index = 0, legacy, scope = {}) {
      const item = isObject(raw) ? raw : {}
      const fallback = {
        ...ROUTE_DEFAULTS,
        triggerOnDirectMessage: index === 0,
        ...(legacy ?? {}),
      }
      const form = { key, fresh: false, id: typeof item.id === 'string' ? item.id : '' }
      for (const field of ROUTE_TEXT) form[field] = typeof item[field] === 'string' ? item[field] : fallback[field]
      for (const field of ROUTE_BOOL) form[field] = typeof item[field] === 'boolean' ? item[field] : fallback[field]
      for (const field of ROUTE_LIST) {
        const value = item[field] ?? scope[field]
        form[field] = Array.isArray(value) ? value.filter((part) => typeof part === 'string').join(', ') : typeof value === 'string' ? value : ''
      }
      form.sessionMode = SESSION_MODES.includes(item.sessionMode) ? item.sessionMode : 'shared'
      return form
    }

    function newRoute(taken, template, index = 0) {
      let id
      do {
        id = `route-${Math.random().toString(36).slice(2, 8)}`
      } while (taken.has(id))
      return { ...routeForm(template, id, index), id, fresh: true }
    }

    /** Copy configuration, never identity or a pinned session belonging to the source route. */
    function duplicateRoute(source, taken, mentions, botUsername) {
      const base = mentionOf(source.mentionName || botUsername || 'route')
      const used = new Set(mentions.map((name) => mentionOf(name).toLowerCase()))
      let mentionName = `${base}-copy`
      for (let suffix = 2; used.has(mentionName.toLowerCase()); suffix += 1) mentionName = `${base}-copy-${suffix}`
      return { ...newRoute(taken, source), mentionName, sessionId: '' }
    }

    /** The stored form of a route list: ids kept (or derived), and all triggers explicit after editing. */
    function routesValue(routes) {
      return routes.map((route) => {
        const value = { id: route.id.trim() || route.key }
        const mentionName = mentionOf(route.mentionName)
        if (mentionName) value.mentionName = mentionName
        if (route.workspace.trim()) value.workspace = route.workspace.trim()
        value.sessionMode = route.sessionMode
        if (route.sessionMode === 'shared' && route.sessionId.trim()) value.sessionId = route.sessionId.trim()
        for (const field of ROUTE_BOOL) value[field] = route[field]
        // Explicit empty arrays override old environment-level filters after a route is edited.
        for (const field of ROUTE_LIST) value[field] = splitList(route[field])
        value.triggerPattern = route.triggerPattern.trim()
        value.triggerPatternFlags = route.triggerPatternFlags.trim()
        return value
      })
    }

    function connectionForm(raw, key) {
      const item = isObject(raw) ? raw : {}
      const form = { key, fresh: false, id: typeof item.id === 'string' ? item.id : '', token: '' }
      for (const field of CONNECTION_TEXT) form[field] = typeof item[field] === 'string' ? item[field] : CONNECTION_DEFAULTS[field]
      for (const field of CONNECTION_BOOL) form[field] = typeof item[field] === 'boolean' ? item[field] : CONNECTION_DEFAULTS[field]
      for (const field of CONNECTION_LIST) form[field] = Array.isArray(item[field]) ? item[field].filter((part) => typeof part === 'string').join(', ') : ''
      // Older profiles put triggers and the session directly on the environment.
      // Show their effective behavior until saving routes writes explicit triggers.
      form.legacyMentionName = typeof item.mentionName === 'string' ? item.mentionName : ''
      form.legacySessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
      form.legacyTriggers = {
        triggerOnMention: item.triggerOnMention !== false,
        triggerOnDirectMessage: item.triggerOnDirectMessage !== false,
        followThreads: item.followThreads === true,
        matchMentionsList: item.matchMentionsList === true,
        triggerPattern: typeof item.triggerPattern === 'string' ? item.triggerPattern : '',
        triggerPatternFlags: typeof item.triggerPatternFlags === 'string' ? item.triggerPatternFlags : 'i',
      }
      const routes = Array.isArray(item.routes) ? item.routes : []
      const legacy = routes.length > 0 && routes.every((route) => ROUTE_TRIGGER_FIELDS.every((field) => route?.[field] == null))
      const keys = routeKeys(routes)
      form.routes = routes.map((route, index) => routeForm(route, keys[index], index, legacy ? form.legacyTriggers : undefined, item))
      return form
    }

    /** The editable form of a stored configuration value (effective values; tokens are never present). */
    function toForm(value) {
      const stored = isObject(value) ? value : {}
      const list = Array.isArray(stored.connections) ? stored.connections : []
      const keys = connectionKeys(list)
      const shared = {}
      for (const field of SHARED_TEXT) shared[field] = typeof stored[field] === 'string' ? stored[field] : SHARED_DEFAULTS[field]
      for (const field of SHARED_BOOL) shared[field] = typeof stored[field] === 'boolean' ? stored[field] : SHARED_DEFAULTS[field]
      for (const field of Object.keys(SHARED_NUMBER)) shared[field] = String(typeof stored[field] === 'number' && Number.isFinite(stored[field]) ? stored[field] : SHARED_DEFAULTS[field])
      shared.replyMode = stored.replyMode === 'all' ? 'all' : 'final'
      const storedMessages = isObject(stored.messages) ? stored.messages : {}
      const messages = {}
      for (const [key, fallback] of Object.entries(DEFAULT_MESSAGES)) {
        const text = storedMessages[key]
        messages[key] = typeof text === 'string' && text !== fallback ? text : ''
      }
      return { connections: list.map((raw, index) => connectionForm(raw, keys[index])), shared, messages }
    }

    function newConnection(taken) {
      let id
      do {
        id = `env-${Math.random().toString(36).slice(2, 8)}`
      } while (taken.has(id))
      return { ...connectionForm({}, id), id, fresh: true }
    }

    /** The stored object of a new environment: id, booleans, and the non-empty fields. */
    function connectionValue(form) {
      const value = { id: form.id || form.key }
      for (const field of CONNECTION_TEXT) {
        const text = form[field].trim()
        if (text !== '' && text !== CONNECTION_DEFAULTS[field]) value[field] = text
      }
      for (const field of CONNECTION_BOOL) value[field] = form[field]
      for (const field of CONNECTION_LIST) {
        const list = splitList(form[field])
        if (list.length > 0) value[field] = list
      }
      if (form.routes.length > 0) value.routes = routesValue(form.routes)
      if (form.token.trim() !== '') value.token = form.token.trim()
      return value
    }

    function validUrl(text) {
      const raw = text.trim()
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      } catch {
        return false
      }
    }

    /** Field problems keyed `<environment key>.<field>`, `<environment key>.routes.<route key>.<field>` or `shared.<field>`. */
    function validate(draft) {
      const problems = {}
      for (const form of draft.connections) {
        if (form.serverUrl.trim() !== '' && !validUrl(form.serverUrl)) problems[`${form.key}.serverUrl`] = { key: 'invalidUrl' }
        const seen = new Set()
        for (const route of form.routes) {
          const prefix = `${form.key}.routes.${route.key}`
          const mention = mentionOf(route.mentionName).toLowerCase()
          if (mention !== '' && !/^[a-z0-9._-]+$/.test(mention)) problems[`${prefix}.mentionName`] = { key: 'invalidMention' }
          else if (seen.has(mention)) problems[`${prefix}.mentionName`] = { key: 'duplicateMention' }
          seen.add(mention)
          const flags = route.triggerPatternFlags.trim()
          if (!/^[dgimsuvy]*$/.test(flags)) problems[`${prefix}.triggerPatternFlags`] = { key: 'invalidFlags' }
          else if (route.triggerPattern.trim() !== '') {
            try {
              new RegExp(route.triggerPattern.trim(), [...new Set(flags.replace(/[gy]/g, ''))].join(''))
            } catch {
              problems[`${prefix}.triggerPattern`] = { key: 'invalidPattern' }
            }
          }
        }
      }
      for (const [field, rule] of Object.entries(SHARED_NUMBER)) {
        const text = draft.shared[field].trim()
        if (text === '') continue
        const number = Number(text)
        if (!Number.isFinite(number) || (rule.integer && !Number.isInteger(number))) problems[`shared.${field}`] = { key: 'invalidNumber' }
        else if (number < rule.min) problems[`shared.${field}`] = { key: 'tooSmall', values: { min: rule.min } }
      }
      return problems
    }

    /**
     * Settings path operations turning the stored value into `draft`.
     * Existing environments are edited field by field (their hidden tokens
     * stay untouched); removals run from the highest index; new environments
     * are appended last.
     */
    function buildOps(draft, storedValue) {
      const stored = toForm(storedValue)
      const ops = []
      const set = (path, value) => ops.push({ op: 'set', path, value })
      const unset = (path) => ops.push({ op: 'unset', path })
      for (const field of SHARED_TEXT) {
        const next = draft.shared[field]
        const previous = stored.shared[field]
        if (field === 'promptHeader') {
          if (next !== previous) next === DEFAULT_PROMPT_HEADER ? unset([field]) : set([field], next)
          continue
        }
        if (next.trim() === previous.trim()) continue
        next.trim() === '' || next.trim() === SHARED_DEFAULTS[field] ? unset([field]) : set([field], next.trim())
      }
      for (const field of SHARED_BOOL) if (draft.shared[field] !== stored.shared[field]) set([field], draft.shared[field])
      if (draft.shared.replyMode !== stored.shared.replyMode) set(['replyMode'], draft.shared.replyMode)
      for (const field of Object.keys(SHARED_NUMBER)) {
        const next = draft.shared[field].trim()
        if (next === stored.shared[field].trim()) continue
        if (next === '') unset([field])
        else if (Number.isFinite(Number(next))) set([field], Number(next))
      }
      for (const key of Object.keys(DEFAULT_MESSAGES)) {
        const next = draft.messages[key]
        if (next === stored.messages[key]) continue
        next.trim() === '' ? unset(['messages', key]) : set(['messages', key], next)
      }
      const indexOf = new Map(stored.connections.map((form, index) => [form.key, index]))
      const kept = new Set()
      const appended = []
      for (const form of draft.connections) {
        const index = form.fresh ? undefined : indexOf.get(form.key)
        if (index === undefined) {
          appended.push(form)
          continue
        }
        kept.add(form.key)
        const previous = stored.connections[index]
        const at = (field) => ['connections', String(index), field]
        for (const field of CONNECTION_TEXT) {
          const next = form[field].trim()
          if (next === previous[field].trim()) continue
          next === '' ? unset(at(field)) : set(at(field), next)
        }
        for (const field of CONNECTION_BOOL) if (form[field] !== previous[field]) set(at(field), form[field])
        for (const field of CONNECTION_LIST) {
          const next = splitList(form[field])
          if (next.join('\n') === splitList(previous[field]).join('\n')) continue
          next.length === 0 ? unset(at(field)) : set(at(field), next)
        }
        // Routes hold no secrets: a changed list is written whole.
        const routes = routesValue(form.routes)
        if (JSON.stringify(routes) !== JSON.stringify(routesValue(previous.routes))) routes.length === 0 ? unset(at('routes')) : set(at('routes'), routes)
        if (form.token.trim() !== '') set(at('token'), form.token.trim())
      }
      const removed = stored.connections.map((form, index) => (kept.has(form.key) ? -1 : index)).filter((index) => index >= 0).sort((a, b) => b - a)
      for (const index of removed) unset(['connections', String(index)])
      let next = stored.connections.length - removed.length
      for (const form of appended) set(['connections', String(next++)], connectionValue(form))
      return { ops, problems: validate(draft) }
    }

    // ------------------------------------------------------------- host API

    async function api(path, init) {
      const url = new URL(`api/dsh-mattermost/${encodeURIComponent(ROW)}/${path}`, document.baseURI)
      const response = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init && init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      })
      let data
      try { data = await response.json() } catch {}
      if (!isObject(data)) throw new Error(`HTTP ${response.status}`)
      return data
    }

    /** The authenticated Host endpoint projects the current DSH workspaceRegistry.list(). */
    async function fetchConfiguredWorkspaces() {
      const data = await api('workspaces')
      return Array.isArray(data.workspaces) ? data.workspaces : null
    }

    function liveState(form, status, t) {
      if (!form.enabled) return { tone: 'idle', text: t('stateDisabled') }
      if (form.fresh) return { tone: 'idle', text: t('stateUnsaved') }
      if (!status) return { tone: 'idle', text: t('stateUnknown') }
      switch (status.state) {
        case 'connected': return { tone: 'ok', text: status.bot ? fill(t('stateConnectedAs'), { bot: status.bot }) : t('stateConnected') }
        case 'connecting': return { tone: 'warn', text: t('stateConnecting') }
        case 'starting': return { tone: 'warn', text: t('stateStarting') }
        case 'reconnecting': return { tone: 'warn', text: t('stateReconnecting') }
        case 'auth-failed': return { tone: 'error', text: t('stateAuthFailed') }
        case 'error': return { tone: 'error', text: t('stateError') }
        case 'unconfigured': return { tone: 'idle', text: t('stateUnconfigured') }
        case 'disabled': return { tone: 'idle', text: t('stateDisabled') }
        default: return { tone: 'idle', text: String(status.state ?? t('stateUnknown')) }
      }
    }

    // ----------------------------------------------------------- components

    function Switch({ id, checked, onChange, disabled, label }) {
      return h('button', {
        id, type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, className: `${C}-switch`, disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: `${C}-thumb` }))
    }

    function Field({ id, label, hint, problem, extra, t, children }) {
      return h('div', { className: `${C}-field` },
        h('div', { className: `${C}-head` }, h('label', { className: `${C}-label`, htmlFor: id }, label), extra ?? null),
        children,
        problem ? h('p', { className: `${C}-error`, role: 'alert' }, fill(t(problem.key), problem.values ?? {})) : null,
        hint ? h('p', { className: `${C}-hint` }, hint) : null)
    }

    function TextInput({ id, value, onChange, disabled, placeholder, type, invalid, multiline, compact, ariaLabel }) {
      const props = {
        id, value, disabled, placeholder, className: `${C}-input${compact ? ` ${C}-regex-flags` : ''}`, spellCheck: false,
        autoComplete: type === 'password' ? 'new-password' : 'off',
        ...(invalid ? { 'aria-invalid': true } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        onChange: (event) => onChange(event.target.value),
      }
      return multiline ? h('textarea', { ...props, rows: 3 }) : h('input', { ...props, type: type ?? 'text' })
    }

    /** Select a registered DSH workspace by path; preserve a configured path that disappeared from the registry. */
    function WorkspacePicker({ id, value, workspaces, disabled, onChange, onRefresh, emptyLabel, t }) {
      const available = Array.isArray(workspaces)
      const listed = available && workspaces.some((workspace) => workspace.path === value)
      const options = [h('option', { key: '', value: '' }, emptyLabel)]
      if (value && !listed) options.push(h('option', { key: `unlisted:${value}`, value }, fill(t('workspaceUnlisted'), { path: value })))
      if (available) {
        for (const workspace of workspaces) {
          options.push(h('option', { key: workspace.id ?? workspace.path, value: workspace.path }, `${workspace.title} — ${workspace.path}`))
        }
      }
      return h('div', { className: `${C}-row` },
        h('select', { id, className: `${C}-input`, value, disabled: disabled || !available, onChange: (event) => onChange(event.target.value) }, options),
        h('button', { type: 'button', className: `${C}-button`, disabled, onClick: onRefresh }, t('refresh')))
    }

    function workspaceHintOf(workspaces, value, baseHint, t) {
      if (workspaces === undefined) return t('workspacesLoading')
      if (!Array.isArray(workspaces)) return t('workspacesUnavailable')
      if (value && !workspaces.some((workspace) => workspace.path === value)) return t('routeWorkspaceNew')
      if (workspaces.length === 0) return t('workspacesEmpty')
      return baseHint
    }

    function Toggle({ id, label, hint, checked, onChange, disabled }) {
      return h('div', { className: `${C}-toggle` },
        h('div', { className: `${C}-toggle-text` },
          h('label', { className: `${C}-label`, htmlFor: id }, label),
          hint ? h('p', { className: `${C}-hint` }, hint) : null),
        h(Switch, { id, checked, onChange, disabled, label }))
    }

    function sessionLabel(session, t) {
      const title = session.title || t('untitledSession')
      return session.workspace ? `${title} · ${session.workspace}` : title
    }

    /** Session select of a shared-mode route; sessions of the route's workspace are listed. */
    function SessionPicker({ id, value, target, sessions, workspace, disabled, onChange, onRefresh, t }) {
      const selected = value.trim()
      const current = selected !== '' || !target
        ? null
        : target.source === 'binding' && target.id
          ? fill(t('currentBinding'), { session: target.title ? `${target.title} (${target.id})` : target.id })
          : target.source === 'auto-create' ? t('currentAuto') : target.source === 'none' ? t('currentNone') : null
      if (!Array.isArray(sessions)) {
        return h(Field, { id, label: t('session'), hint: current ?? (sessions === null ? t('sessionsUnavailable') : t('sessionHint')), t },
          h(TextInput, { id, value, onChange, disabled, placeholder: 'session-…' }))
      }
      const scoped = workspace ? sessions.filter((session) => session.path === workspace) : sessions
      const listed = new Set(scoped.map((session) => session.id))
      const options = [h('option', { key: '', value: '' }, t('sessionAuto'))]
      if (selected !== '' && !listed.has(selected)) {
        const known = sessions.find((session) => session.id === selected)
        options.push(h('option', { key: selected, value: selected }, known ? sessionLabel(known, t) : `${selected} ${t('sessionNotListed')}`))
      }
      for (const session of scoped) options.push(h('option', { key: session.id, value: session.id }, sessionLabel(session, t)))
      return h(Field, { id, label: t('session'), hint: current ?? t('sessionHint'), t },
        h('div', { className: `${C}-row` },
          h('select', { id, className: `${C}-input`, value: selected, disabled, onChange: (event) => onChange(event.target.value) }, options),
          h('button', { type: 'button', className: `${C}-button`, disabled, onClick: onRefresh }, t('refresh'))))
    }

    const MODE_TAG = { shared: 'tagShared', thread: 'tagThread', new: 'tagNew' }

    /** Collapsed route cards: each owns its triggers and session settings. */
    function RouteEditor({ form, status, sessions, workspaces, expandedRoutes = new Set(), disabled, problems, t, onRouteChange, onAllMatchesChange, onAddRoute, onDuplicateRoute, onRemoveRoute, onToggleRoute, onRefreshSessions, onRefreshWorkspaces }) {
      const bot = status?.bot
      const liveRoutes = new Map((status?.routes ?? []).map((route) => [route.key, route]))
      const known = new Map((Array.isArray(workspaces) ? workspaces : []).map((workspace) => [workspace.path, workspace]))
      return h('div', { className: `${C}-section` },
        h('p', { className: `${C}-group-title` }, t('routes')),
        h('p', { className: `${C}-hint` }, t('routesHint')),
        form.routes.length > 1 ? h(Toggle, { id: `${C}-${form.key}-routeToAllMatches`, label: t('routeToAllMatches'), hint: t('routeToAllMatchesHint'), checked: form.routeToAllMatches, onChange: onAllMatchesChange, disabled }) : null,
        form.routes.length === 0 ? h('p', { className: `${C}-hint`, style: { paddingTop: 8 } }, fill(t('noRoutes'), { bot: bot ?? 'bot' })) : null,
        form.routes.map((route) => {
          const id = (field) => `${C}-${form.key}-${route.key}-${field}`
          const change = (field) => (value) => onRouteChange(form.key, route.key, field, value)
          const problem = (field) => problems[`${form.key}.routes.${route.key}.${field}`]
          const mention = mentionOf(route.mentionName) || bot || ''
          const path = route.workspace.trim()
          const workspace = path ? known.get(path) : undefined
          const workspaceHint = workspace
            ? fill(t('routeWorkspaceKnown'), { title: workspace.title })
            : workspaceHintOf(workspaces, path, t('routeWorkspaceHint'), t)
          const modeHint = route.sessionMode === 'thread' ? t('currentThread') : route.sessionMode === 'new' ? t('currentNew') : undefined
          const expanded = expandedRoutes.has(JSON.stringify([form.key, route.key]))
          const hasError = Object.keys(problems).some((key) => key.startsWith(`${form.key}.routes.${route.key}.`)) || Boolean(liveRoutes.get(route.key)?.patternError)
          return h('div', { key: route.key, className: `${C}-route`, 'data-route': route.key },
            h('div', { className: `${C}-route-head`, onClick: () => onToggleRoute(form.key, route.key) },
              h('button', { type: 'button', className: `${C}-route-name`, 'aria-expanded': expanded, 'aria-controls': id('body') },
                h('span', { className: `${C}-chevron`, 'aria-hidden': true }),
                `${mention ? `@${mention}` : t('routeMention')}${workspace ? ` → ${workspace.title}` : path ? ` → ${path}` : ''}`),
              h('span', { className: `${C}-tag`, 'data-tone': hasError ? 'error' : undefined }, hasError ? t('routeInvalid') : t(MODE_TAG[route.sessionMode] ?? 'tagShared')),
              (splitList(route.channels).length || splitList(route.allowedUsers).length) ? h('span', { className: `${C}-tag`, title: [route.channels, route.allowedUsers].filter(Boolean).join(' · ') }, t('scopeRestricted')) : null,
              h('button', { type: 'button', className: `${C}-button`, disabled, onClick: (event) => { event?.stopPropagation(); onDuplicateRoute(form.key, route.key) } }, t('duplicateRoute')),
              h('button', { type: 'button', className: `${C}-button`, 'data-variant': 'danger', disabled, onClick: (event) => { event?.stopPropagation(); onRemoveRoute(form.key, route.key) } }, t('removeRoute'))),
            expanded ? h('div', { id: id('body'), className: `${C}-route-body` },
              h(Field, { id: id('mentionName'), label: t('routeMention'), hint: t('routeMentionHint'), problem: problem('mentionName'), t },
                h(TextInput, { id: id('mentionName'), value: route.mentionName, onChange: change('mentionName'), disabled, invalid: Boolean(problem('mentionName')), placeholder: bot ?? 'orion-agent' })),
              h(Field, { id: id('workspace'), label: t('routeWorkspace'), hint: workspaceHint, t },
                h(WorkspacePicker, { id: id('workspace'), value: route.workspace, workspaces, disabled, onChange: change('workspace'), onRefresh: onRefreshWorkspaces, emptyLabel: t('workspaceInherit'), t })),
              h(Field, { id: id('sessionMode'), label: t('sessionMode'), hint: modeHint, t },
                h('select', { id: id('sessionMode'), className: `${C}-input`, value: route.sessionMode, disabled, onChange: (event) => change('sessionMode')(event.target.value) },
                  h('option', { value: 'shared' }, t('modeShared')),
                  h('option', { value: 'thread' }, t('modeThread')),
                  h('option', { value: 'new' }, t('modeNew')))),
              route.sessionMode === 'shared'
                ? h(SessionPicker, { id: id('sessionId'), value: route.sessionId, target: route.fresh ? undefined : liveRoutes.get(route.key)?.target, sessions, workspace: path, disabled, onChange: change('sessionId'), onRefresh: onRefreshSessions, t })
                : null,
              h('p', { className: `${C}-group-title` }, t('triggers')),
              h('p', { className: `${C}-hint` }, t('routeTriggerHint')),
              h(Toggle, { id: id('triggerOnDirectMessage'), label: t('onDirect'), checked: route.triggerOnDirectMessage, onChange: change('triggerOnDirectMessage'), disabled }),
              h(Toggle, { id: id('followThreads'), label: t('followThreads'), checked: route.followThreads, onChange: change('followThreads'), disabled }),
              h(Toggle, { id: id('matchMentionsList'), label: t('matchMentionsList'), hint: t('matchMentionsListHint'), checked: route.matchMentionsList, onChange: change('matchMentionsList'), disabled }),
              h(Field, { id: id('triggerPattern'), label: t('pattern'), hint: t('patternHint'), problem: problem('triggerPattern') ?? problem('triggerPatternFlags'), t },
                h('div', { className: `${C}-row` },
                  h(TextInput, { id: id('triggerPattern'), value: route.triggerPattern, onChange: change('triggerPattern'), disabled, invalid: Boolean(problem('triggerPattern')), placeholder: '^!ask\\s+(?<prompt>[\\s\\S]+)' }),
                  h(TextInput, { id: id('triggerPatternFlags'), value: route.triggerPatternFlags, onChange: change('triggerPatternFlags'), disabled, invalid: Boolean(problem('triggerPatternFlags')), compact: true, ariaLabel: t('patternFlags'), placeholder: 'i' }))),
              liveRoutes.get(route.key)?.patternError ? h('p', { className: `${C}-error`, role: 'alert' }, liveRoutes.get(route.key).patternError) : null,
              h('p', { className: `${C}-group-title` }, t('scope')),
              h(Field, { id: id('channels'), label: t('channels'), hint: t('channelsHint'), t },
                h(TextInput, { id: id('channels'), value: route.channels, onChange: change('channels'), disabled, placeholder: 'town-square, dev' })),
              h(Field, { id: id('allowedUsers'), label: t('allowedUsers'), hint: t('allowedUsersHint'), t },
                h(TextInput, { id: id('allowedUsers'), value: route.allowedUsers, onChange: change('allowedUsers'), disabled, placeholder: 'alice, bob' })))
              : null)
        }),
        h('div', { className: `${C}-routes-foot` },
          h('button', { type: 'button', className: `${C}-button`, disabled, onClick: () => onAddRoute(form.key) }, `+ ${t('addRoute')}`)),
        h('p', { className: `${C}-hint` }, t('duplicateRouteHint')))
    }

    function ConnectionCard(props) {
      const { form, status, sessions, expanded, disabled, problems, test, t } = props
      const id = (field) => `${C}-${form.key}-${field}`
      const problem = (field) => problems[`${form.key}.${field}`]
      const change = (field) => (value) => props.onChange(form.key, field, value)
      const text = (field, extra = {}) => h(TextInput, { id: id(field), value: form[field], onChange: change(field), disabled, invalid: Boolean(problem(field)), ...extra })
      const state = liveState(form, status, t)
      const hasRouteError = Object.keys(problems).some((key) => key.startsWith(`${form.key}.routes.`)) || Boolean(status?.patternError)
      const title = form.name.trim() || hostOf(form.serverUrl) || t('untitledEnvironment')
      const subtitle = [form.serverUrl.trim(), status?.target?.title ? `→ ${status.target.title}` : ''].filter(Boolean).join('  ')
      const tokenSaved = Boolean(status?.hasToken)
      const testText = test === 'running' ? t('testing')
        : test?.ok ? fill(t('testOk'), { user: test.username ?? '?' })
        : test?.unavailable ? fill(t('testUnavailable'), { error: test.error })
        : test ? fill(t('testFailed'), { error: test.error ?? '?' }) : null
      return h('div', { className: `${C}-card`, 'data-environment': form.key },
        h('div', { className: `${C}-card-head` },
          h('span', { className: `${C}-dot`, 'data-tone': state.tone, 'aria-hidden': true }),
          h('div', { className: `${C}-card-title` },
            h('span', { className: `${C}-name` }, title),
            subtitle ? h('span', { className: `${C}-sub` }, subtitle) : null),
          h('span', { className: `${C}-tag`, 'data-tone': state.tone, role: 'status' }, state.text),
          hasRouteError ? h('span', { className: `${C}-tag`, 'data-tone': 'error' }, t('routeInvalid')) : null,
          h(Switch, { id: id('enabled'), checked: form.enabled, onChange: change('enabled'), disabled, label: t('enabledLabel') }),
          h('button', { type: 'button', className: `${C}-button`, 'data-variant': 'quiet', 'aria-expanded': expanded, onClick: () => props.onToggle(form.key) }, expanded ? t('collapse') : t('edit'))),
        !expanded && status?.lastError && form.enabled ? h('p', { className: `${C}-error` }, fill(t('lastError'), { error: status.lastError })) : null,
        expanded ? h('div', { className: `${C}-body` },
          h(Field, { id: id('name'), label: t('name'), hint: t('nameHint'), t }, text('name')),
          h(Field, { id: id('serverUrl'), label: t('serverUrl'), hint: t('serverUrlHint'), problem: problem('serverUrl'), t }, text('serverUrl', { placeholder: 'https://mattermost.example.com' })),
          h(Field, {
            id: id('token'), label: t('token'), hint: t('tokenHint'), t,
            extra: h('span', { className: `${C}-tag`, 'data-tone': tokenSaved || form.token.trim() !== '' ? 'ok' : undefined }, tokenSaved ? t('tokenSaved') : t('tokenMissing')),
          }, text('token', { type: 'password', placeholder: t('tokenPlaceholder') })),
          h('div', { className: `${C}-field` },
            h('div', { className: `${C}-row` },
              h('button', { type: 'button', className: `${C}-button`, disabled: disabled || test === 'running', onClick: () => props.onTest(form) }, test === 'running' ? t('testing') : t('test')),
              testText ? h('p', { className: test === 'running' ? `${C}-hint` : test?.ok ? `${C}-ok` : `${C}-error`, role: 'status' }, testText) : null)),
          h(RouteEditor, {
            form, status, sessions, workspaces: props.workspaces, expandedRoutes: props.expandedRoutes, disabled, problems, t,
            onRouteChange: props.onRouteChange, onAllMatchesChange: change('routeToAllMatches'), onAddRoute: props.onAddRoute, onDuplicateRoute: props.onDuplicateRoute, onRemoveRoute: props.onRemoveRoute, onToggleRoute: props.onToggleRoute,
            onRefreshSessions: props.onRefreshSessions, onRefreshWorkspaces: props.onRefreshWorkspaces,
          }),
          h('p', { className: `${C}-group-title` }, t('greeting')),
          h(Toggle, { id: id('greetingEnabled'), label: t('greetingEnabled'), checked: form.greetingEnabled, onChange: change('greetingEnabled'), disabled }),
          form.greetingEnabled ? h(Field, { id: id('greetingChannelId'), label: t('greetingChannelId'), t }, text('greetingChannelId')) : null,
          form.greetingEnabled ? h(Field, { id: id('greetingMessage'), label: t('greetingMessage'), t }, text('greetingMessage', { placeholder: fill(t('defaultText'), { text: 'Agent is now online and ready. You can use @… to request my support.' }) })) : null,
          form.greetingEnabled ? h(Field, { id: id('goodbyeMessage'), label: t('goodbyeMessage'), t }, text('goodbyeMessage', { placeholder: fill(t('defaultText'), { text: 'Agent is shutting down. Goodbye.' }) })) : null,
          status?.lastError && form.enabled ? h('p', { className: `${C}-error`, style: { paddingBottom: 8 } }, fill(t('lastError'), { error: status.lastError })) : null,
          h('div', { className: `${C}-actions` },
            !form.fresh && form.enabled ? h('button', { type: 'button', className: `${C}-button`, disabled, onClick: () => props.onReconnect(form.key) }, t('reconnect')) : null,
            h('button', { type: 'button', className: `${C}-button`, 'data-variant': 'danger', disabled, onClick: () => props.onRemove(form.key) }, t('remove')))) : null)
    }

    function SharedSection({ shared, problems, workspaces, disabled, onChange, onRefreshWorkspaces, t }) {
      const id = (field) => `${C}-shared-${field}`
      const change = (field) => (value) => onChange(field, value)
      const number = (field) => h(Field, { id: id(field), label: t(field), hint: t(`${field}Hint`), problem: problems[`shared.${field}`], t },
        h(TextInput, { id: id(field), value: shared[field], onChange: change(field), disabled, invalid: Boolean(problems[`shared.${field}`]), placeholder: String(SHARED_DEFAULTS[field]) }))
      return h('section', { className: `${C}-section` },
        h('div', { className: `${C}-section-head` }, h('h3', { className: `${C}-section-title` }, t('shared'))),
        h('p', { className: `${C}-hint` }, t('sharedHint')),
        h(Toggle, { id: id('autoCreateSession'), label: t('autoCreateSession'), checked: shared.autoCreateSession, onChange: change('autoCreateSession'), disabled }),
        h(Field, { id: id('workspace'), label: t('workspace'), hint: workspaceHintOf(workspaces, shared.workspace, t('workspaceHint'), t), t },
          h(WorkspacePicker, { id: id('workspace'), value: shared.workspace, workspaces, disabled, onChange: change('workspace'), onRefresh: onRefreshWorkspaces, emptyLabel: t('workspaceFirst'), t })),
        h(Field, { id: id('sessionTitle'), label: t('sessionTitle'), hint: t('sessionTitleHint'), t },
          h(TextInput, { id: id('sessionTitle'), value: shared.sessionTitle, onChange: change('sessionTitle'), disabled, placeholder: SHARED_DEFAULTS.sessionTitle })),
        number('maxConcurrent'),
        h(Field, { id: id('replyMode'), label: t('replyMode'), t },
          h('select', { id: id('replyMode'), className: `${C}-input`, value: shared.replyMode, disabled, onChange: (event) => onChange('replyMode', event.target.value) },
            h('option', { value: 'final' }, t('replyModeFinal')),
            h('option', { value: 'all' }, t('replyModeAll')))),
        number('replyTimeoutMinutes'),
        number('threadContextMaxMessages'),
        number('queueMaxSize'),
        number('maxPostLength'),
        h(Toggle, { id: id('mentionSender'), label: t('mentionSender'), checked: shared.mentionSender, onChange: change('mentionSender'), disabled }),
        h(Toggle, { id: id('typingIndicator'), label: t('typingIndicator'), checked: shared.typingIndicator, onChange: change('typingIndicator'), disabled }),
        h(Toggle, { id: id('ignoreBots'), label: t('ignoreBots'), checked: shared.ignoreBots, onChange: change('ignoreBots'), disabled }),
        h(Toggle, { id: id('showHost'), label: t('showHost'), checked: shared.showHost, onChange: change('showHost'), disabled }),
        h(Field, {
          id: id('promptHeader'), label: t('promptHeader'), hint: t('promptHeaderHint'), t,
          extra: shared.promptHeader !== DEFAULT_PROMPT_HEADER
            ? h('button', { type: 'button', className: `${C}-button`, 'data-variant': 'quiet', disabled, onClick: () => onChange('promptHeader', DEFAULT_PROMPT_HEADER) }, t('resetDefault'))
            : null,
        }, h(TextInput, { id: id('promptHeader'), value: shared.promptHeader, onChange: change('promptHeader'), disabled, multiline: true })))
    }

    function Collapsible({ title, hint, open, onToggle, children, t }) {
      return h('section', { className: `${C}-section` },
        h('div', { className: `${C}-section-head` },
          h('h3', { className: `${C}-section-title` }, title),
          h('button', { type: 'button', className: `${C}-button`, 'data-variant': 'quiet', 'aria-expanded': open, onClick: onToggle }, open ? t('hide') : t('show'))),
        hint ? h('p', { className: `${C}-hint` }, hint) : null,
        open ? children : null)
    }

    function SettingsPage({ form, t }) {
      const subscribe = useCallback((listener) => form.subscribe(listener), [form])
      const getSnapshot = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const stored = useMemo(() => toForm(snapshot.value), [snapshot.value])
      const [draft, setDraft] = useState(undefined)
      const [expanded, setExpanded] = useState(() => new Set())
      const [expandedRoutes, setExpandedRoutes] = useState(() => new Set())
      const [saveState, setSaveState] = useState(undefined)
      const [live, setLive] = useState(undefined)
      const [sessions, setSessions] = useState(undefined)
      const [workspaces, setWorkspaces] = useState(undefined)
      const [tests, setTests] = useState({})
      const [showMessages, setShowMessages] = useState(false)
      const [showAdvanced, setShowAdvanced] = useState(false)
      const current = draft ?? stored

      useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const data = await api('status')
            if (alive && Array.isArray(data.connections)) setLive(Object.fromEntries(data.connections.map((item) => [item.key, item])))
          } catch {
            if (alive) setLive(null)
          }
          if (alive) timer = setTimeout(tick, 3000)
        }
        void tick()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [])

      const loadSessions = useCallback(async () => {
        try {
          const data = await api('sessions')
          setSessions(Array.isArray(data.sessions) ? data.sessions : null)
        } catch {
          setSessions(null)
        }
      }, [])
      const loadWorkspaces = useCallback(async () => {
        try {
          setWorkspaces(await fetchConfiguredWorkspaces())
        } catch {
          setWorkspaces(null)
        }
      }, [])
      useEffect(() => {
        void loadSessions()
        void loadWorkspaces()
      }, [loadSessions, loadWorkspaces])

      const editable = snapshot.status === 'ready' && snapshot.writable
      const { ops, problems } = useMemo(() => buildOps(current, snapshot.value), [current, snapshot.value])
      const invalid = Object.keys(problems).length > 0
      const dirty = ops.length > 0
      const busy = saveState === 'saving'
      const disabled = !editable || busy

      const edit = (mutate) => {
        setDraft((previous) => {
          const next = structuredClone(previous ?? stored)
          mutate(next)
          return next
        })
        setSaveState(undefined)
      }
      const onConnectionChange = (key, field, value) => edit((next) => {
        const target = next.connections.find((item) => item.key === key)
        if (target) target[field] = value
      })
      const routeOf = (next, connectionKey, routeKey) => next.connections.find((item) => item.key === connectionKey)?.routes.find((item) => item.key === routeKey)
      const onRouteChange = (connectionKey, routeKey, field, value) => edit((next) => {
        const route = routeOf(next, connectionKey, routeKey)
        if (route) route[field] = value
      })
      const onAddRoute = (connectionKey) => {
        const owner = current.connections.find((item) => item.key === connectionKey)
        if (!owner) return
        const first = owner.routes.length === 0
        const template = first ? { mentionName: owner.legacyMentionName, sessionId: owner.legacySessionId, ...owner.legacyTriggers } : undefined
        const created = newRoute(new Set(owner.routes.map((route) => route.key)), template, owner.routes.length)
        for (const field of ROUTE_LIST) created[field] = owner[field]
        edit((next) => { next.connections.find((item) => item.key === connectionKey)?.routes.push(created) })
        setExpandedRoutes((previous) => new Set([...previous, JSON.stringify([connectionKey, created.key])]))
      }
      const onDuplicateRoute = (connectionKey, routeKey) => {
        const owner = current.connections.find((item) => item.key === connectionKey)
        const source = owner?.routes.find((item) => item.key === routeKey)
        if (!source) return
        const copy = duplicateRoute(source, new Set(owner.routes.map((item) => item.key)), owner.routes.map((item) => item.mentionName), live?.[connectionKey]?.bot)
        edit((next) => { next.connections.find((item) => item.key === connectionKey)?.routes.push(copy) })
        setExpandedRoutes((previous) => new Set([...previous, JSON.stringify([connectionKey, copy.key])]))
      }
      const routeId = (connectionKey, routeKey) => JSON.stringify([connectionKey, routeKey])
      const onToggleRoute = (connectionKey, routeKey) => setExpandedRoutes((previous) => {
        const next = new Set(previous)
        const key = routeId(connectionKey, routeKey)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const onRemoveRoute = (connectionKey, routeKey) => {
        edit((next) => {
          const owner = next.connections.find((item) => item.key === connectionKey)
          if (owner) owner.routes = owner.routes.filter((route) => route.key !== routeKey)
        })
        setExpandedRoutes((previous) => {
          const next = new Set(previous)
          next.delete(routeId(connectionKey, routeKey))
          return next
        })
      }
      const onAdd = () => {
        const taken = new Set(current.connections.map((item) => item.key))
        const created = newConnection(taken)
        edit((next) => { next.connections.push(created) })
        setExpanded((previous) => new Set([...previous, created.key]))
      }
      const onRemove = (key) => edit((next) => { next.connections = next.connections.filter((item) => item.key !== key) })
      const onToggle = (key) => setExpanded((previous) => {
        const next = new Set(previous)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      const onTest = async (target) => {
        setTests((previous) => ({ ...previous, [target.key]: 'running' }))
        let result
        try {
          result = await api('test', { method: 'POST', body: JSON.stringify({ key: target.fresh ? undefined : target.key, serverUrl: target.serverUrl, token: target.token }) })
        } catch (error) {
          result = { ok: false, unavailable: true, error: error instanceof Error ? error.message : String(error) }
        }
        setTests((previous) => ({ ...previous, [target.key]: result }))
      }
      const onReconnect = (key) => {
        api('reconnect', { method: 'POST', body: JSON.stringify({ key }) }).catch(() => {})
      }
      const save = async () => {
        if (invalid) {
          setSaveState('invalid')
          const badConnections = current.connections.filter((item) => Object.keys(problems).some((key) => key.startsWith(`${item.key}.`)))
          setExpanded((previous) => new Set([...previous, ...badConnections.map((item) => item.key)]))
          setExpandedRoutes((previous) => new Set([...previous, ...badConnections.flatMap((item) => item.routes
            .filter((route) => Object.keys(problems).some((key) => key.startsWith(`${item.key}.routes.${route.key}.`)))
            .map((route) => JSON.stringify([item.key, route.key])))]))
          return
        }
        if (!dirty) return
        setSaveState('saving')
        try {
          const ok = await form.mutate(ops, snapshot.revision)
          setSaveState(ok ? 'saved' : 'failed')
          if (ok) {
            setDraft(undefined)
            setTests({})
          }
        } catch {
          setSaveState('failed')
        }
      }

      if (snapshot.status === 'loading') return h('p', { className: `${C}-hint`, role: 'status' }, t('loading'))

      const footer = saveState === 'saving' ? [undefined, t('saving')]
        : saveState === 'saved' && !dirty ? ['ok', t('saved')]
        : saveState === 'failed' ? ['error', t('failed')]
        : invalid && (dirty || saveState === 'invalid') ? ['error', t('invalid')]
        : !editable ? ['error', t('unavailable')]
        : dirty ? [undefined, t('unsaved')]
        : [undefined, t('commandsHint')]

      return h('div', { className: `${C}-root`, 'data-dsh-mattermost-config': '' },
        h('style', null, CSS),
        h('p', { className: `${C}-intro` }, t('intro')),
        h('section', { className: `${C}-section` },
          h('div', { className: `${C}-section-head` },
            h('h3', { className: `${C}-section-title` }, t('environments')),
            h('button', { type: 'button', className: `${C}-button`, disabled, onClick: onAdd }, `+ ${t('addEnvironment')}`)),
          current.connections.length === 0
            ? h('p', { className: `${C}-empty` }, t('noEnvironments'))
            : current.connections.map((item) => h(ConnectionCard, {
              key: item.key, form: item, status: live?.[item.key], sessions, workspaces, expanded: expanded.has(item.key), expandedRoutes, disabled, problems, test: tests[item.key], t,
              onChange: onConnectionChange, onToggle, onRemove, onTest, onReconnect,
              onRefreshSessions: () => void loadSessions(), onRefreshWorkspaces: () => void loadWorkspaces(),
              onRouteChange, onAddRoute, onDuplicateRoute, onRemoveRoute, onToggleRoute,
            }))),
        h(SharedSection, { shared: current.shared, problems, workspaces, disabled, t, onRefreshWorkspaces: () => void loadWorkspaces(), onChange: (field, value) => edit((next) => { next.shared[field] = value }) }),
        h(Collapsible, { title: t('messages'), hint: t('messagesHint'), open: showMessages, onToggle: () => setShowMessages(!showMessages), t },
          Object.keys(DEFAULT_MESSAGES).map((key) => h(Field, { key, id: `${C}-message-${key}`, label: t(`message.${key}`), t },
            h(TextInput, { id: `${C}-message-${key}`, value: current.messages[key], disabled, placeholder: DEFAULT_MESSAGES[key], onChange: (value) => edit((next) => { next.messages[key] = value }) })))),
        h(Collapsible, { title: t('advanced'), open: showAdvanced, onToggle: () => setShowAdvanced(!showAdvanced), t },
          h(Field, { id: `${C}-shared-debugLogFile`, label: t('debugLogFile'), hint: t('debugLogFileHint'), t },
            h(TextInput, { id: `${C}-shared-debugLogFile`, value: current.shared.debugLogFile, disabled, placeholder: '/tmp/dsh-mattermost.log', onChange: (value) => edit((next) => { next.shared.debugLogFile = value }) })),
          h(Field, { id: `${C}-shared-stateFile`, label: t('stateFile'), hint: t('stateFileHint'), t },
            h(TextInput, { id: `${C}-shared-stateFile`, value: current.shared.stateFile, disabled, placeholder: '~/.dsh/mattermost/state.json', onChange: (value) => edit((next) => { next.shared.stateFile = value }) }))),
        h('div', { className: `${C}-footer` },
          h('p', { className: `${C}-footer-text`, 'data-tone': footer[0], role: 'status' }, footer[1]),
          dirty ? h('button', { type: 'button', className: `${C}-button`, disabled, onClick: () => { setDraft(undefined); setSaveState(undefined) } }, t('discard')) : null,
          h('button', { type: 'button', className: `${C}-save`, disabled: disabled || !dirty, onClick: () => void save() }, busy ? t('saving') : t('save'))))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mattermost: locale')
        const bound = ctx.locale.bind(NS)
        const form = ctx.configForms.get(ROW)
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PKG,
          locale: NS,
        }, ({ view, t }) => (view === 'page' ? h(SettingsPage, { form, t: t ?? bound }) : null))), 'dsh-mattermost: settings page')
      },
      /** Pure helpers and the page component, for tests only. */
      testing: { toForm, buildOps, validate, connectionKeys, routeKeys, newConnection, newRoute, duplicateRoute, DEFAULT_MESSAGES, DEFAULT_PROMPT_HEADER, CONNECTION_DEFAULTS, ROUTE_DEFAULTS, SHARED_DEFAULTS, zh, en, SettingsPage, ConnectionCard, RouteEditor, SharedSection, WorkspacePicker, fetchConfiguredWorkspaces },
    }
  },
})
