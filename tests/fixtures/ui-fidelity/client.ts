/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- Test-only dynamic DSH slot boundary; require resolves the host React singleton. */
/** Test-only replacement of the bundle client in one Chrome tab via Fetch
 * interception. Uses the real DSH shell, React, slots and Markdown renderer.
 * Team HTTP and wait responses are local fixtures; no business writes occur. */
import { installTaskResources } from '../../../packages/web/src/task-resource-panel'
import { installTeamReview } from '../../../packages/web/src/task-review-card'
import { installTeamQuestions } from '../../../packages/web/src/team-question-card'
import { installTeamProgress } from '../../../packages/web/src/team-progress-card'
import { createReviewSessionStore } from '../../../packages/web/src/review-session'
export const inject = ['slots', 'layout']
export function apply(context: any) {
  const react = require('react'); const h = react.createElement
  const markdown = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText
  let mode = 'review'; let fail = false; let paused = false; let resetParts = () => {}
  const store = createReviewSessionStore()
  const hash = 'a'.repeat(64)
  const before = '# 客户管理设计方案\n\n## 本期范围\n新增、查询、修改客户信息。\n\n## 字段规则\n联系人必填。\n\n## 查询与列表\n按名称查询。'
  const content = '# 客户管理设计方案\n\n## 本期范围\n新增、查询、修改客户信息。\n本期不包含批量导入与导出。\n\n## 字段规则\n联系人与邮箱选填，手机号重复时提示已有客户。\n\n## 查询与列表\n支持名称和电话查询，列表显示联系人与电话。\n\n## 验收计划\n覆盖新增、查询、修改以及重复提示。'
  const files = [{ path: 'specs/visual-qa/plan.md', category: '方案文档', content }, { path: 'specs/visual-qa/data-model.md', category: '方案文档', content: '# 数据设计\n\n客户名称、联系电话、联系人与邮箱。' }, { path: 'specs/visual-qa/test-plan.md', category: '方案文档', content: '# 验收计划\n\n覆盖新增、查询、修改和重复提示。' }]
  const state = () => ({ schemaVersion:1, taskId:'visual-qa', workspaceId:'visual-qa', workspaceName:'视觉验收', phase:mode==='approved'?'BUILD':'AWAIT_DESIGN_APPROVAL', compatibility:{mode:'supported'}, developmentRun:{status:paused?'paused':'running'}, ...(mode==='approved'?{}:{pendingApproval:{id:'visual-qa',kind:'design',summary:'请确认实现方案',artifactHash:hash}}), experts:[], risk:{level:'normal',messages:[]}, database:{runtime:'stopped',engine:'PostgreSQL',guiAvailable:false},verification:{total:0,passed:0,failed:0,blocked:0},usage:{activeExperts:0,activeWorkers:0,concurrentWriters:0,remainingTaskBudget:0},lastSequence:1,stateRevision:4 })
  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
    if (!url.pathname.startsWith('/plugins/backend-team/control/')) return originalFetch(input, init)
    if (mode==='error') return new Response('{}',{status:503})
    if (url.pathname.endsWith('/state')) return Response.json(state())
    if (url.pathname.endsWith('/resources')) return Response.json({taskId:'visual-qa', phase:state().phase, files:mode==='empty'?[]:files,tasks:[{id:'visual-qa',title:'客户管理功能 · 验收样例'}],changes:{available:true,files:[{path:files[0].path,before,after:content}]},...(mode==='approved'?{approvalHistory:[{kind:'design',approvedAt:'2026-09-09T02:30:00Z'}]}:{})})
    if (url.pathname.endsWith('/dispatch')) { const body=JSON.parse(init?.body as string); if(body.type==='open-artifact') return Response.json({accepted:true,artifactPreview:{artifactHash:hash,files}}); if(body.type==='pause-run'){paused=true;return Response.json({accepted:true})};return new Response('{}',{status:400}) }
    return new Response('{}',{status:404})
  }
  const wait = () => ({kind:'question',key:'visual-'+mode,sessionId:'visual-qa',payload:{questions:mode==='questions'?[{id:'Q1',header:'需求确认',question:'使用哪种重复判断方式？',options:[{label:'手机号'},{label:'名称与电话组合'}]},{id:'Q2',header:'需求确认',question:'谁可以修改客户信息？',options:[{label:'所有业务成员'},{label:'仅客户负责人'},{label:'仅管理员'}]}]:[{id:'backend-team-review:visual-qa',header:'审批设计方案',question:'请确认当前设计方案'}]},respond:async (result: unknown)=>{if(fail)return {accepted:false};console.info('UI-QA receipt',JSON.stringify(result));return {accepted:true}}})
  const wrapped = { layout:context.layout, slots:{inject:(name: string,fn: any)=>context.slots.inject(name,fn),register:(config: any,render: any)=>context.slots.register({...config,...(config.select?{select:()=>config.select({interactions:['review','questions'].includes(mode)?[wait()]:[]})}:{})},(props: any)=>render({...props,sessionId:'visual-qa'}))} }
  let disposeParts = () => {}
  const mount = () => { const resources=installTaskResources(wrapped,react,markdown,store);const review=installTeamReview(wrapped,react,resources.open,store);const questions=installTeamQuestions(wrapped,react);const progress=installTeamProgress(wrapped,react,resources.open);disposeParts=()=>{progress();questions();review();resources.dispose()};return resources }
  let resources=mount()
  resetParts=()=>{disposeParts();store.dispose();resources=mount();resources.open()}
  function Controls(){const [value,setValue]=react.useState(mode);react.useEffect(()=>{resources.open()},[]);return h('div',{className:'bt-ui',style:{display:'flex',gap:8,alignItems:'center'}},h('span',{className:'bt-muted'},'UI 验收 · 模拟任务'),h('select',{'aria-label':'验收状态',value,onChange:(event:any)=>{mode=event.target.value;setValue(mode);resetParts()}},...Object.entries({review:'待审批',questions:'逐题问题',approved:'已批准 / 执行',empty:'空状态',error:'加载失败'}).map(([key,label])=>h('option',{key,value:key},label))),h('label',null,h('input',{type:'checkbox',onChange:(event:any)=>{fail=event.target.checked}}),'模拟提交失败'))}
  const controls=context.slots.inject('conversation.session.header.utilities',()=>context.slots.register({name:'conversation.session.header.utilities',id:'visual-qa-controls',order:45},()=>h(Controls)))
  return ()=>{controls();disposeParts();window.fetch=originalFetch;store.dispose()}
}
