import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FolderOpen, FileText, ArrowLeft, X, Search, MessageSquare, Plus, ArrowUp, PanelRight, Check, Clock, CirclePause } from 'lucide-react'
import { createShadcnComponents } from '../../../packages/web/src/ui/primitives.js'
import type { BackendTeamReactLike } from '../../../packages/web/src/client-overlay.js'

const { Button, Badge, Textarea } = createShadcnComponents(React as unknown as BackendTeamReactLike) as unknown as { Button: React.ComponentType<Record<string, unknown>>; Badge: React.ComponentType<Record<string, unknown>>; Textarea: React.ComponentType<Record<string, unknown>> }
const initial = [
  { id: 1, title: '客户管理', state: '未完成', phase: '开发尚未运行', summary: '新增、查询和修改客户信息。', docs: ['需求规范', '架构设计', '接口契约', '实现计划'], date: '今天 09:56', origin: '客户管理功能' },
  { id: 2, title: '演示接口', state: '已搁置', phase: '测试验收阶段', summary: '一个用于演示的问候接口。', docs: ['需求规范', '设计方案', '验收报告'], date: '昨天 19:03', origin: '新增演示用后端接口' },
  { id: 3, title: '连接检查', state: '已完成', phase: '已交付', summary: '验证本地服务连接状态。', docs: ['交付报告'], date: '9月7日', origin: '验证会话连接' },
]
type Task = typeof initial[number]
function App() {
  const [tasks, setTasks] = useState(initial)
  const [open, setOpen] = useState(true)
  const [filter, setFilter] = useState('全部')
  const [query, setQuery] = useState('')
  const [viewed, setViewed] = useState<number | null>(null)
  const [bound, setBound] = useState<number | null>(null)
  const [doc, setDoc] = useState('')
  const [intent, setIntent] = useState('')
  const [comment, setComment] = useState('')
  const [receipt, setReceipt] = useState('')
  const task = tasks.find(t => t.id === viewed)
  const current = tasks.find(t => t.id === bound)
  const select = (t: Task) => { setViewed(t.id); setDoc(''); setIntent(''); setComment('') }
  function confirm() {
    if (!task) return
    if (comment.trim()) { setReceipt('已保留你的补充意见，等待团队澄清。任务状态未改变。'); setIntent(''); return }
    if (intent === '接回当前对话') { setBound(task.id); setTasks(tasks.map(t => t.id === task.id ? { ...t, state: '未完成' } : t)); setReceipt(`已接回「${task.title}」。尚未恢复执行，也未批准新需求。`) }
    if (intent === '搁置任务') { setTasks(tasks.map(t => t.id === task.id ? { ...t, state: '已搁置' } : t)); if (bound === task.id) setBound(null); setReceipt(`已搁置「${task.title}」，代码和文档已保留。`) }
    setIntent('')
  }
  return <div className="bt-ui shell">
    <aside className="sessions"><h3>DeepSeek Harness</h3><Button className="wide" onClick={() => { setBound(null); setReceipt('已切换到新对话。工作区旧任务仍可查看。') }}><Plus size={16}/>新会话</Button><p className="muted">工作区</p><div className="workspace"><FolderOpen size={17}/>travel</div><div className="session active"><MessageSquare size={15}/>客户跟进功能</div><div className="session">客户管理功能</div><div className="session">新增演示用后端接口</div><div className="note">会话用于沟通；团队任务与产物保留在工作区。</div></aside>
    <main className="chat"><header><div><strong>客户跟进功能</strong><small>交互原型 · 所有任务均为示例</small></div><Button onClick={() => setOpen(!open)}><PanelRight size={16}/>团队任务</Button></header>
      <div className="binding"><span className="muted">当前团队任务</span><strong>{current?.title ?? '尚未关联'}</strong>{current && <Badge>{current.phase}</Badge>}<button className="link" onClick={() => { setOpen(true); if (current) select(current) }}>查看任务</button></div>
      <div className="messages"><div className="bubble">帮我做一个客户跟进功能，能记录联系情况和下次跟进时间。</div><p>工作区还有一个未完成的「客户管理」任务。你可以先查看原任务，再决定继续它，或搁置后开始这次新需求。</p><div className="inline-card"><FolderOpen size={20}/><div><strong>客户管理</strong><small>开发尚未运行 · 原任务审批不覆盖本次新增需求</small></div><Button onClick={() => { setOpen(true); select(tasks[0]!) }}>查看原任务</Button></div><p className="muted">查看任务和文档不会启动开发，也不会改变当前对话的任务归属。</p>{receipt && <div className="receipt" role="status"><Check size={18}/>{receipt}</div>}</div>
      <div className="composer"><Textarea aria-label="继续对话" placeholder="继续补充需求，或询问团队进展…"/><div><Button size="icon" aria-label="添加附件" onClick={() => setReceipt('此原型只演示任务交互，附件沿用聊天输入区。')}><Plus size={18}/></Button><span className="muted">Qwen3.8 Flash</span><Button size="icon" variant="default" aria-label="发送示例" onClick={() => setReceipt('这是交互原型，不会向模型发送消息。')}><ArrowUp size={18}/></Button></div></div>
    </main>
    {open && <aside className="resources"><header><strong>团队任务</strong><Button variant="ghost" size="icon" aria-label="关闭团队任务" onClick={() => setOpen(false)}><X size={18}/></Button></header>
      {!task ? <><div className="tools"><div className="search"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索工作区任务" aria-label="搜索工作区任务"/></div><div className="filters" role="group" aria-label="任务状态">{['全部', '未完成', '已搁置', '已完成'].map(f => <Button key={f} variant="ghost" size="sm" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</Button>)}</div><small>此工作区的所有任务，包括其他会话和归档会话中的任务。</small></div><div className="task-list">{tasks.filter(t => (filter === '全部' || t.state === filter) && t.title.includes(query)).map(t => <button className="task-row" key={t.id} onClick={() => select(t)}><div className="row-title"><FolderOpen size={18}/><strong>{t.title}</strong><Badge tone={t.state === '已完成' ? 'success' : 'neutral'}>{t.state}</Badge></div><p>{t.summary}</p><small>{t.phase} · {t.date}</small>{bound === t.id && <small className="blue">当前对话的任务</small>}</button>)}{!tasks.some(t => (filter === '全部' || t.state === filter) && t.title.includes(query)) && <div className="empty">没有符合条件的任务</div>}</div></> : <><div className="task-heading"><Button variant="ghost" size="sm" onClick={() => { setViewed(null); setIntent('') }}><ArrowLeft size={16}/>所有任务</Button><h2>{task.title} <Badge>{task.state}</Badge></h2><small>{bound === task.id ? '当前对话的任务' : `来自会话：${task.origin}`} · 仅查看</small></div><div className="detail">
        {doc ? <><Button variant="ghost" size="sm" onClick={() => setDoc('')}><ArrowLeft size={16}/>任务概览</Button><h2><FileText size={22}/>{doc}</h2><Badge>示例文档</Badge><h3>范围</h3><p>{task.summary}</p><h3>版本与审批</h3><p>此处展示该文档的真实版本、审批时间与操作来源。来源无法核实时显示“审批待核实”。</p><p className="muted">本次新增的客户跟进需求，仍需单独完成需求与设计确认。</p></> : <><div className="status-box"><Clock size={18}/><div><strong>{task.phase}</strong><small>查看资料不会开始执行</small></div></div><h3>原任务范围</h3><p>{task.summary}</p><h3>任务资源 <span className="muted">{task.docs.length}</span></h3>{task.docs.map(d => <button className="document" key={d} onClick={() => setDoc(d)}><FileText size={17}/>{d}<span>查看</span></button>)}<h3>操作记录</h3><p className="muted">{task.date} · {task.state}。审批来源和历史变更可在相关文档中核对。</p></>}
      </div>{intent ? <section className="decision"><h3>{intent}：{task.title}</h3><p>{intent === '搁置任务' ? '保留已有代码、文档和进度，释放工作区占用；不会把任务标记为完成。' : '当前对话将管理这个原任务。接回后仍需明确继续，新需求不会沿用原审批。'}</p><label htmlFor="comment">补充意见（可选）</label><Textarea id="comment" value={comment} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setComment(e.target.value)} placeholder="有其他要求，可以在这里补充"/><div className="actions"><Button onClick={() => setIntent('')}>取消</Button><Button variant="default" onClick={confirm}>{comment.trim() ? '提交意见，暂不变更' : '确认' + (intent === '搁置任务' ? '搁置' : '接回')}</Button></div></section> : task.state !== '已完成' && <footer><small>管理操作需要明确确认，不会自动批准文档。</small><div className="actions">{task.state !== '已搁置' && <Button onClick={() => { setIntent('搁置任务'); setComment('') }}><CirclePause size={16}/>搁置任务</Button>}{bound !== task.id && <Button variant="default" onClick={() => { setIntent('接回当前对话'); setComment('') }}>接回当前对话</Button>}</div></footer>}</>}
    </aside>}
  </div>
}
createRoot(document.getElementById('root')!).render(<App/> )
