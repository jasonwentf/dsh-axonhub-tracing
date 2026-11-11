// Client half: a settings card that shows which providers are tagged, lets the
// user override the default, and lists the most recent request headers.
//
// The host owns the settings document, so every change here is one small RPC.
// The card keeps an optimistic copy so switches feel instant.

window.__ModuleLoader__.load({
  id: 'dsh-axonhub-tracing',
  factory: (require) => {
    const React = require('react')

    function h(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    const styles = {
      root: { padding: '4px 0 12px', fontSize: 13, lineHeight: 1.5, color: 'currentColor' },
      section: { marginTop: 18 },
      title: { fontSize: 12, opacity: 0.62, marginBottom: 6, letterSpacing: '0.02em' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '7px 0',
        borderBottom: '1px solid rgba(128,128,128,0.16)',
      },
      rowMain: { minWidth: 0, flex: 1 },
      id: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      hint: { fontSize: 11, opacity: 0.55, marginTop: 1 },
      seg: {
        display: 'inline-flex',
        border: '1px solid rgba(128,128,128,0.32)',
        borderRadius: 7,
        overflow: 'hidden',
      },
      segButton: {
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        cursor: 'pointer',
        opacity: 0.6,
      },
      segActive: { background: 'rgba(128,128,128,0.22)', opacity: 1 },
      check: { width: 16, height: 16, cursor: 'pointer' },
      badge: {
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.3)',
        opacity: 0.7,
        whiteSpace: 'nowrap',
      },
      link: {
        background: 'none',
        border: 0,
        color: 'inherit',
        opacity: 0.55,
        fontSize: 11,
        cursor: 'pointer',
        textDecoration: 'underline',
        padding: 0,
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
      th: { textAlign: 'left', fontWeight: 500, opacity: 0.55, padding: '4px 6px 4px 0', whiteSpace: 'nowrap' },
      td: { padding: '4px 6px 4px 0', borderTop: '1px solid rgba(128,128,128,0.12)', verticalAlign: 'top' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' },
      empty: { opacity: 0.5, fontSize: 12, padding: '8px 0' },
      error: { color: '#d9534f', fontSize: 12, marginTop: 6 },
      switch: {
        width: 36,
        height: 20,
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.4)',
        background: 'transparent',
        position: 'relative',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      knob: {
        position: 'absolute',
        top: 2,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: 'currentColor',
        transition: 'left 120ms ease',
      },
    }

    function fmtTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    const KIND_LABEL = {
      user: '对话',
      subagent: '子代理',
      title: '标题',
      approval: '审批',
      compaction: '压缩',
      system: '其他',
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { style: styles.seg },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              style: value === option.value ? { ...styles.segButton, ...styles.segActive } : styles.segButton,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    function Switch({ checked, onChange, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-label': label,
          'aria-checked': Boolean(checked),
          style: styles.switch,
          onClick: () => onChange(!checked),
        },
        h('span', { style: { ...styles.knob, left: checked ? 18 : 2 } }),
      )
    }

    function SettingsRow({ label, hint, children }) {
      return h(
        'div',
        { style: styles.row },
        h(
          'div',
          { style: styles.rowMain },
          h('div', null, label),
          hint ? h('div', { style: styles.hint }, hint) : null,
        ),
        children,
      )
    }

    function ProviderRow({ provider, settings, onChange, onReset }) {
      const overrides = settings.overrides ?? {}
      const has = Object.prototype.hasOwnProperty.call(overrides, provider.id)
      const forced = has ? overrides[provider.id] : undefined
      const effective =
        forced !== undefined
          ? forced
          : settings.mode === 'all' || (settings.mode === 'auto' && provider.auto)
      const badge =
        forced !== undefined ? (forced ? '手动开' : '手动关') : provider.auto ? '自动命中' : '默认不启用'
      return h(
        'div',
        { style: styles.row },
        h('input', {
          type: 'checkbox',
          style: styles.check,
          checked: effective,
          onChange: () => onChange(provider.id, !effective),
        }),
        h(
          'div',
          { style: { ...styles.rowMain, marginLeft: -4 } },
          h('div', { style: styles.id }, provider.id),
          provider.name !== provider.id ? h('div', { style: styles.hint }, provider.name) : null,
          provider.baseURL ? h('div', { style: styles.hint }, provider.baseURL) : null,
        ),
        h('span', { style: styles.badge }, badge),
        has ? h('button', { type: 'button', style: styles.link, onClick: () => onReset(provider.id) }, '恢复默认') : null,
      )
    }

    function createPanel(transport) {
      return function AxonHubTracingPanel() {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState('')

        const refresh = React.useCallback(
          async (alive) => {
            try {
              const next = await transport.read()
              if (alive?.() === false) return
              setState(next)
              setError('')
            } catch (problem) {
              if (alive?.() === false) return
              setError(problem?.message ?? String(problem))
            }
          },
          [],
        )

        React.useEffect(() => {
          let live = true
          const alive = () => live
          refresh(alive)
          const timer = setInterval(() => refresh(alive), 3000)
          return () => {
            live = false
            clearInterval(timer)
          }
        }, [refresh])

        const settings = state?.settings ?? { enabled: true, mode: 'auto', overrides: {} }
        const providers = state?.providers ?? []
        const recent = state?.recent ?? []
        const persisted = state?.persisted !== false

        const apply = async (patch) => {
          const optimistic = { ...settings, ...patch }
          setState((current) => (current === null ? current : { ...current, settings: optimistic }))
          try {
            const next = await transport.update(patch)
            setState((current) =>
              current === null
                ? current
                : { ...current, settings: next.settings, persisted: next.persisted !== false },
            )
            setError('')
          } catch (problem) {
            setError(problem?.message ?? String(problem))
            refresh(() => true)
          }
        }

        const setField = (field, value) => apply({ [field]: value })
        // Provider toggles go through a dedicated call that changes exactly one
        // key on the host. Sending the whole map from the client would let two
        // quick clicks overwrite each other with a stale copy.
        const setOverride = async (id, value) => {
          setState((current) =>
            current === null
              ? current
              : {
                  ...current,
                  settings: {
                    ...current.settings,
                    overrides: { ...(current.settings.overrides ?? {}), [id]: value },
                  },
                },
          )
          try {
            const next = await transport.setProvider(id, value)
            setState((current) =>
              current === null
                ? current
                : { ...current, settings: next.settings, persisted: next.persisted !== false },
            )
            setError('')
          } catch (problem) {
            setError(problem?.message ?? String(problem))
            refresh(() => true)
          }
        }
        const resetOverride = (id) => setOverride(id, null)

        return h(
          'div',
          { style: styles.root },
          h(
            SettingsRow,
            { label: '启用 AxonHub 追踪', hint: '关掉后请求头立刻恢复原样' },
            h(Switch, {
              checked: settings.enabled !== false,
              onChange: (next) => setField('enabled', next),
              label: '启用',
            }),
          ),

          h('div', { style: styles.section }, h('div', { style: styles.title }, '默认范围')),
          h(
            SettingsRow,
            { label: '没有被单独勾选的渠道怎么算', hint: '自动只认名字或地址里带 axon 的渠道' },
            h(Segmented, {
              value: settings.mode ?? 'auto',
              options: [
                { value: 'auto', label: '自动' },
                { value: 'all', label: '全部' },
                { value: 'none', label: '全关' },
              ],
              onChange: (next) => setField('mode', next),
            }),
          ),

          h('div', { style: styles.section }, h('div', { style: styles.title }, '渠道')),
          providers.length === 0
            ? h('div', { style: styles.empty }, '还没有读到渠道列表，先发一条消息再回来看')
            : providers.map((provider) =>
                h(ProviderRow, {
                  key: provider.id,
                  provider,
                  settings,
                  onChange: setOverride,
                  onReset: resetOverride,
                }),
              ),

          h('div', { style: styles.section }, h('div', { style: styles.title }, '分组方式')),
          h(
            SettingsRow,
            { label: '子代理', hint: '独立线程时不占用主会话的时间线，但可能被分到其他渠道，取决于上游配置' },
            h(Segmented, {
              value: settings.subagentThread ?? 'own',
              options: [
                { value: 'own', label: '独立' },
                { value: 'parent', label: '跟父会话' },
              ],
              onChange: (next) => setField('subagentThread', next),
            }),
          ),
          h(
            SettingsRow,
            { label: '标题', hint: '独立线程时，起标题不占用主会话的时间线' },
            h(Segmented, {
              value: settings.titleThread ?? 'own',
              options: [
                { value: 'own', label: '独立' },
                { value: 'shared', label: '跟主会话' },
              ],
              onChange: (next) => setField('titleThread', next),
            }),
          ),
          h(
            SettingsRow,
            { label: '审批', hint: '独立线程时，自动审批不占用主会话的时间线' },
            h(Segmented, {
              value: settings.approvalThread ?? 'own',
              options: [
                { value: 'own', label: '独立' },
                { value: 'shared', label: '跟主会话' },
              ],
              onChange: (next) => setField('approvalThread', next),
            }),
          ),
          h(
            SettingsRow,
            { label: '轮次追踪', hint: '打开后每一轮单独一条追踪，关闭后整段会话共用一条，两者都不影响渠道粘性' },
            h(Switch, {
              checked: settings.turnTracking !== false,
              onChange: (next) => setField('turnTracking', next),
              label: '轮次追踪',
            }),
          ),
          h('div', { style: styles.hint }, '压缩摘要始终跟随当前轮次，方便缓存命中'),

          h(
            'div',
            { style: styles.section },
            h('div', { style: styles.title }, `最近 ${recent.length} 条已打标的请求`),
          ),
          error !== '' ? h('div', { style: styles.error }, error) : null,
          persisted ? null : h('div', { style: styles.error }, '设置已经生效，但写入设置文件失败，重启后会回到旧值'),
          recent.length === 0
            ? h('div', { style: styles.empty }, '还没有抓到请求。发一条消息或者点一次起标题，这里就会出现')
            : h(
                'table',
                { style: styles.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: styles.th }, '时间'),
                    h('th', { style: styles.th }, '类型'),
                    h('th', { style: styles.th }, '渠道'),
                    h('th', { style: styles.th }, '追踪'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  recent.map((entry, index) =>
                    h(
                      'tr',
                      { key: `${entry.at}-${index}` },
                      h('td', { style: styles.td }, fmtTime(entry.at)),
                      h('td', { style: styles.td }, KIND_LABEL[entry.kind] ?? entry.kind),
                      h('td', { style: styles.td }, entry.provider),
                      h('td', { style: styles.td }, h('div', { style: styles.mono, title: entry.trace }, entry.trace)),
                    ),
                  ),
                ),
              ),
        )
      }
    }

    function createTransport(connection) {
      if (typeof connection?.rpc?.call !== 'function') {
        throw new Error('当前应用不支持读取插件状态')
      }
      const call = async (method, args) => {
        const result = await connection.rpc.call('/api', `axonhubTracing/${method}`, { args })
        if (!result?.ok) {
          throw new Error(result?.error?.message ?? '读取插件状态失败')
        }
        return result.value
      }
      return {
        read: () => call('getState', {}),
        update: (patch) => call('updateSettings', { patch }),
        setProvider: (id, value) => call('setProvider', { id, value }),
      }
    }

    const plugin = {
      name: 'dsh-axonhub-tracing',
      inject: [],
      apply(ctx) {
        const cleanups = []
        let seat = null
        let off = null

        // The client boots services in order, so wait for both the slot
        // registry and the RPC carrier instead of sampling them once.
        ctx.inject(['slots', 'connection'], (scope) => {
          const slots = scope.get('slots')
          const connection = scope.get('connection')
          if (!slots?.register || !slots?.inject || !connection) return
          try {
            const transport = createTransport(connection)
            const Panel = createPanel(transport)
            off = slots.inject('settings.plugins.tab', () => {
              seat = slots.register(
                {
                  name: 'settings.plugins.tab',
                  id: 'axonhub-tracing',
                  order: 30,
                  label: 'AxonHub 追踪',
                  inject: () => ({}),
                },
                Panel,
              )
              return seat
            })
            cleanups.push(() => {
              try {
                if (typeof seat === 'function') seat()
                else seat?.dispose?.()
              } catch {
                /* the slot may already be gone */
              }
              try {
                off?.()
              } catch {
                /* the injector may already be gone */
              }
            })
          } catch (error) {
            console.warn('[axonhub-tracing] 设置卡片没有加载：', error)
          }
        })

        return () => {
          for (const cleanup of cleanups.reverse()) {
            try {
              cleanup?.()
            } catch {
              /* never escape into boot */
            }
          }
          cleanups.length = 0
        }
      },
      dispose() {},
    }
    return plugin
  },
})
