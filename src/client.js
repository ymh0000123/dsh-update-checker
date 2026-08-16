// Client half of the "DSH 更新检测" dynamic Cordis plugin (updt-1 / pkg-8).
// This is the exact `code.client` body, wrapped as an ES module default export.
// To load it as a dynamic plugin via cordis_define, use the function body
// (the part inside `export default function () { ... }`) as code.client.
export default function () {
function UpdateChecker(props) {
  const timer = props && props.timer
  const [state, setState] = React.useState({ phase: 'loading', report: null, error: null })
  const [progress, setProgress] = React.useState(null)
  const [filter, setFilter] = React.useState('all')
  const [query, setQuery] = React.useState('')
  const [updating, setUpdating] = React.useState({})
  const [updateMsg, setUpdateMsg] = React.useState(null)
  const [collapsed, setCollapsed] = React.useState({ npm: false, github: false })

  const refresh = (force) => {
    setState({ phase: 'loading', report: state.report, error: null })
    setProgress({ active: true, phase: 'init', current: 0, total: 1, message: '正在启动检查…' })
    host.call('check-updates', force ? { force: true } : {}).then(
      (report) => setState({ phase: 'done', report, error: null }),
      (err) => setState({ phase: 'done', report: null, error: String((err && err.message) || err) }),
    )
  }

  const runUpdate = (name) => {
    setUpdating((prev) => Object.assign({}, prev, { [name]: 'updating' }))
    setUpdateMsg(null)
    host.call('perform-update', { name }).then(
      (res) => {
        const ok = !!(res && res.ok)
        setUpdating((prev) => Object.assign({}, prev, { [name]: ok ? 'done' : 'error' }))
        setUpdateMsg((res && res.message) || (ok ? '更新完成' : '更新失败'))
      },
      (err) => {
        setUpdating((prev) => Object.assign({}, prev, { [name]: 'error' }))
        setUpdateMsg('更新失败：' + String((err && err.message) || err))
      },
    )
  }

  const toggle = (which) => setCollapsed((prev) => Object.assign({}, prev, { [which]: !prev[which] }))

  React.useEffect(() => {
    refresh(false)
    if (timer) {
      const dispose = timer.interval(() => {
        host.call('check-progress').then((p) => {
          if (p && typeof p === 'object' && p.active) setProgress(p)
        }, () => {})
      }, 250)
      return () => dispose()
    }
  }, [])

  if (state.phase === 'loading') {
    const p = progress || {}
    const total = p.total > 0 ? p.total : 1
    const current = Math.min(p.current || 0, total)
    const pct = Math.round((current / total) * 100)
    const phaseLabel = { init: '初始化', npm: '查询 npm 仓库', github: '检查 GitHub 仓库', done: '完成' }[p.phase] || '检查中'
    return React.createElement('div', { className: 'upd-page' },
      React.createElement('div', { className: 'upd-card' },
        React.createElement('div', { className: 'upd-header' },
          React.createElement('span', null, '正在检查更新…'),
          React.createElement('button', { className: 'upd-btn', onClick: () => refresh(true) }, '重新检测'),
        ),
        React.createElement('div', { className: 'upd-progress' },
          React.createElement('div', { className: 'upd-progress-bar', style: { width: pct + '%' } }),
        ),
        React.createElement('div', { className: 'upd-progress-text' },
          React.createElement('span', { className: 'upd-progress-phase' }, phaseLabel),
          React.createElement('span', { className: 'upd-muted upd-progress-msg' }, p.message ? String(p.message) : ''),
          React.createElement('span', { className: 'upd-muted' }, current + ' / ' + total),
        ),
      ),
    )
  }

  const errMsg = state.error || (state.report && state.report.ok === false ? state.report.error : null)
  if (errMsg) {
    return React.createElement('div', { className: 'upd-page' },
      React.createElement('div', { className: 'upd-card upd-error' },
        React.createElement('div', null, '更新检测失败：' + errMsg),
        React.createElement('button', { className: 'upd-btn', onClick: () => refresh(true) }, '重试'),
      ),
    )
  }

  const report = state.report || {}
  const s = report.summary || {}
  const pkgs = report.packages || []
  const gpkgs = report.github || []
  const gs = report.githubSummary || { total: gpkgs.length, updatable: 0, upToDate: 0, failed: 0 }

  const statusOf = (p) => {
    if (p.error) return 'failed'
    if (p.hasUpdate) return 'update'
    if (p.local === p.latest) return 'latest'
    return 'preview'
  }
  const STATUS = {
    update: { label: '可更新', cls: 'upd-badge-update' },
    latest: { label: '已最新', cls: 'upd-badge-ok' },
    preview: { label: '预发布', cls: 'upd-badge-preview' },
    failed: { label: '失败', cls: 'upd-badge-failed' },
  }
  const counts = { all: pkgs.length, update: s.updatable || 0, latest: s.upToDate || 0, preview: s.preview || 0, failed: s.failed || 0 }
  const order = { update: 0, failed: 1, preview: 2, latest: 3 }

  const filtered = pkgs.filter((p) => {
    if (filter !== 'all' && statusOf(p) !== filter) return false
    if (query && p.name.toLowerCase().indexOf(query.toLowerCase()) < 0) return false
    return true
  })
  const sorted = filtered.slice().sort((a, b) => {
    const d = order[statusOf(a)] - order[statusOf(b)]
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })

  const chips = ['all', 'update', 'latest', 'preview', 'failed'].map((f) =>
    React.createElement('button', {
      key: f,
      className: 'upd-chip' + (filter === f ? ' upd-chip-active' : ''),
      onClick: () => setFilter(f),
    }, (f === 'all' ? '全部' : STATUS[f].label) + ' ' + counts[f]),
  )

  const npmRows = sorted.map((p, i) => {
    const st = statusOf(p)
    const statusEl = p.error
      ? React.createElement('span', { className: 'upd-badge upd-badge-failed', title: String(p.error) }, '失败')
      : React.createElement('span', { className: 'upd-badge ' + STATUS[st].cls }, STATUS[st].label)
    return React.createElement('tr', { key: i },
      React.createElement('td', { className: 'upd-tname' }, p.name),
      React.createElement('td', null, p.local),
      React.createElement('td', null, p.latest || '—'),
      React.createElement('td', null, p.next || '—'),
      React.createElement('td', null, p.maxPublished || '—'),
      React.createElement('td', null, statusEl),
    )
  })
  const npmTable = React.createElement('table', { className: 'upd-table' },
    React.createElement('thead', null,
      React.createElement('tr', null,
        React.createElement('th', null, '包名'),
        React.createElement('th', null, '本机版本'),
        React.createElement('th', null, 'latest'),
        React.createElement('th', null, 'next'),
        React.createElement('th', null, '最高已发布'),
        React.createElement('th', null, '状态'),
      ),
    ),
    React.createElement('tbody', null, ...npmRows),
  )

  const gBadges = []
  gBadges.push(React.createElement('span', { className: 'upd-badge ' + (gs.updatable > 0 ? 'upd-badge-update' : 'upd-badge-ok'), key: 'gu' }, '可更新 ' + gs.updatable))
  gBadges.push(React.createElement('span', { className: 'upd-badge upd-badge-ok', key: 'gt' }, '已最新 ' + gs.upToDate))
  if (gs.failed > 0) gBadges.push(React.createElement('span', { className: 'upd-badge upd-badge-failed', key: 'gf' }, '失败 ' + gs.failed))
  const shortCommit = (c) => (c ? String(c).slice(0, 10) + '…' : '—')
  const gRows = gpkgs.map((p, i) => {
    const st = p.error ? 'failed' : (p.hasUpdate ? 'update' : 'latest')
    const statusEl = p.error
      ? React.createElement('span', { className: 'upd-badge upd-badge-failed', title: String(p.error) }, '失败')
      : React.createElement('span', { className: 'upd-badge ' + STATUS[st].cls }, STATUS[st].label)
    const ustate = updating[p.name] || 'idle'
    let actionEl
    if (p.kind === 'github-dep' && p.hasUpdate) {
      if (ustate === 'updating') actionEl = React.createElement('button', { className: 'upd-btn upd-btn-sm', disabled: true }, '更新中…')
      else if (ustate === 'done') actionEl = React.createElement('span', { className: 'upd-ok upd-small' }, '✓ 已更新')
      else if (ustate === 'error') actionEl = React.createElement('button', { className: 'upd-btn upd-btn-sm', onClick: () => runUpdate(p.name), title: updateMsg || '' }, '重试')
      else actionEl = React.createElement('button', { className: 'upd-btn upd-btn-sm', onClick: () => runUpdate(p.name) }, '更新')
    } else {
      actionEl = React.createElement('span', { className: 'upd-muted' }, '—')
    }
    return React.createElement('tr', { key: i },
      React.createElement('td', { className: 'upd-tname' }, p.name),
      React.createElement('td', { className: 'upd-repo' }, p.repo || '—'),
      React.createElement('td', null, shortCommit(p.installedCommit)),
      React.createElement('td', null, shortCommit(p.latestCommit)),
      React.createElement('td', null, statusEl),
      React.createElement('td', null, actionEl),
    )
  })
  const gTable = React.createElement('table', { className: 'upd-table' },
    React.createElement('thead', null,
      React.createElement('tr', null,
        React.createElement('th', null, '包名'),
        React.createElement('th', null, '仓库'),
        React.createElement('th', null, '已安装 commit'),
        React.createElement('th', null, '远程最新 commit'),
        React.createElement('th', null, '状态'),
        React.createElement('th', null, '操作'),
      ),
    ),
    React.createElement('tbody', null, ...gRows),
  )

  const updAll = (s.updatable || 0) + (gs.updatable || 0)
  const latestAll = (s.upToDate || 0) + (gs.upToDate || 0)
  const failedAll = (s.failed || 0) + (gs.failed || 0)

  const rows = []
  rows.push(React.createElement('div', { className: 'upd-row', key: 'dsh' },
    React.createElement('span', { className: 'upd-name' }, 'DSH 发行版'),
    React.createElement('span', { className: 'upd-vers upd-strong' }, String(report.dshRelease || '未知')),
  ))
  rows.push(React.createElement('div', { className: 'upd-row', key: 'profile' },
    React.createElement('span', { className: 'upd-name' }, 'Profile'),
    React.createElement('span', { className: 'upd-vers' }, String(report.profilePath || '未找到')),
  ))
  rows.push(React.createElement('div', { className: 'upd-row', key: 'at' },
    React.createElement('span', { className: 'upd-name' }, '检查时间'),
    React.createElement('span', { className: 'upd-vers' }, String(report.checkedAt || '').replace('T', ' ').slice(0, 19)),
  ))
  rows.push(React.createElement('div', { className: 'upd-row', key: 'sum' },
    React.createElement('span', { className: 'upd-name' }, '汇总'),
    React.createElement('span', { className: 'upd-vers upd-strong' },
      '共 ' + (pkgs.length + gpkgs.length) + ' 项（npm ' + pkgs.length + ' + GitHub ' + gpkgs.length + '）｜可更新 ' + updAll + '（npm ' + (s.updatable || 0) + ' + GitHub ' + (gs.updatable || 0) + '）｜已最新 ' + latestAll + '｜失败 ' + failedAll,
    ),
  ))

  return React.createElement('div', { className: 'upd-page' },
    React.createElement('div', { className: 'upd-card' },
      React.createElement('div', { className: 'upd-header' },
        React.createElement('span', null, 'DSH 与 @deepseek-ai 包更新'),
        React.createElement('button', { className: 'upd-btn', onClick: () => refresh(true) }, '重新检测'),
      ),
      ...rows,
    ),
    React.createElement('div', { className: 'upd-card' },
      React.createElement('div', { className: 'upd-chips' }, ...chips),
    ),
    React.createElement('div', { className: 'upd-card' },
      React.createElement('div', { className: 'upd-section-head' },
        React.createElement('span', { className: 'upd-subtitle upd-mb0' }, 'npm 包（' + pkgs.length + '）'),
        React.createElement('button', { className: 'upd-chip', onClick: () => toggle('npm') }, collapsed.npm ? '展开 ▸' : '折叠 ▾'),
      ),
      !collapsed.npm ? React.createElement('div', null,
        React.createElement('div', { className: 'upd-toolbar' },
          React.createElement('input', { className: 'upd-search', type: 'text', placeholder: '按包名搜索…', value: query, onChange: (e) => setQuery(e.target.value) }),
          React.createElement('span', { className: 'upd-muted' }, '显示 ' + sorted.length + ' / ' + pkgs.length + ' 个包'),
        ),
        sorted.length > 0
          ? npmTable
          : React.createElement('div', { className: 'upd-muted upd-empty' }, '没有匹配的包。'),
      ) : null,
    ),
    React.createElement('div', { className: 'upd-card' },
      React.createElement('div', { className: 'upd-section-head' },
        React.createElement('span', { className: 'upd-subtitle upd-mb0' }, 'GitHub 源包（' + gpkgs.length + '）'),
        React.createElement('div', null,
          ...gBadges,
          React.createElement('button', { className: 'upd-chip', key: 'toggle', onClick: () => toggle('github') }, collapsed.github ? '展开 ▸' : '折叠 ▾'),
        ),
      ),
      !collapsed.github ? React.createElement('div', null,
        updateMsg ? React.createElement('div', { className: 'upd-msg' }, String(updateMsg)) : null,
        gRows.length > 0
          ? gTable
          : React.createElement('div', { className: 'upd-muted upd-empty' }, '没有 GitHub 源包。'),
      ) : null,
    ),
  )
}

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    const timer = ctx.get('timer')
    if (slots === undefined) return
    styles.insert(`
.upd-page { display: flex; flex-direction: column; gap: 12px; font-size: 14px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
.upd-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); }
.upd-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 10px; }
.upd-subtitle { font-weight: 600; margin-bottom: 8px; }
.upd-mb0 { margin-bottom: 0; }
.upd-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.upd-mb { margin-bottom: 10px; }
.upd-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 4px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.upd-row:last-child { border-bottom: none; }
.upd-name { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.upd-vers { font-size: 12px; white-space: nowrap; }
.upd-strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
.upd-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.upd-chip { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; }
.upd-chip:hover { opacity: 0.85; }
.upd-chip-active { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.upd-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.upd-search { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; }
.upd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.upd-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.upd-table td { padding: 6px 8px; border-bottom: 1px dashed var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.upd-table tr:last-child td { border-bottom: none; }
.upd-table td.upd-tname { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-primary); word-break: break-all; white-space: normal; max-width: 240px; }
.upd-table td.upd-repo { word-break: break-all; white-space: normal; max-width: 200px; }
.upd-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.upd-badge-update { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.upd-badge-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.upd-badge-preview { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.upd-badge-failed { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.upd-muted { opacity: 0.7; font-size: 12px; }
.upd-error { color: var(--dsw-alias-state-error-primary); }
.upd-empty { padding: 12px 0; }
.upd-msg { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.upd-ok { color: var(--dsw-alias-state-success-primary); }
.upd-small { font-size: 12px; }
.upd-progress { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin: 10px 0 6px; }
.upd-progress-bar { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 0.2s ease; }
.upd-progress-text { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.upd-progress-phase { font-weight: 600; }
.upd-progress-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.upd-btn { padding: 4px 14px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; }
.upd-btn:hover { opacity: 0.85; }
.upd-btn:disabled { opacity: 0.6; cursor: default; }
.upd-btn-sm { padding: 2px 10px; font-size: 12px; }
`)
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'update-checker', order: 45, label: '更新检测' },
      (props) => React.createElement(UpdateChecker, { timer }),
    ))
  },
}
}
