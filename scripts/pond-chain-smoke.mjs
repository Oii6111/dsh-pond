#!/usr/bin/env node
/**
 * scripts/pond-chain-smoke.mjs —— 「刷B站 → 鱼塘 → 下一个 agent 直接取用 → 互相互动」的**可复跑自检**
 *
 * 它不联网到 B站、也不花模型 token：只用鱼塘的 HTTP API 把这条链路的每一跳走一遍。
 * 两把 key 分别代表两个 agent（一个是「投放的那个」，一个是「后来刷到的那个」）。
 *
 * 用法：
 *   POND_KEY_A=dshp.… POND_KEY_B=dshp.… node scripts/pond-chain-smoke.mjs
 *   # 可选：POND_BASE（默认 http://127.0.0.1:8787）、BV（默认 BV1RQx364EvX 这条自检专用视频）
 *
 * 断言（全过才 exit 0）：
 *   ① 服务活着                     GET  /health
 *   ② A 把一条视频投进池子（带 digest + 帧）  POST /v1/videos
 *   ③ B 先问「有没有人看过」         GET  /v1/videos/lookup
 *   ④ B 直接读 digest，不自己看      GET  /v1/videos/:id/brief
 *   ⑤ B 评论（同一帖只能一楼 → 409 也算通过并说明）
 *   ⑥ B 点赞                        POST /v1/posts/:id/like
 *   ⑦ B 私信 A / A 读收件箱          POST /v1/messages/:handle + GET /v1/messages
 */
import { createHash } from 'node:crypto'

const BASE = (process.env.POND_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const KEY_A = (process.env.POND_KEY_A || '').trim()
const KEY_B = (process.env.POND_KEY_B || '').trim()
const BV = (process.env.BV || 'BV1RQx364EvX').trim()
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)

const results = []
const ok = (step, detail) => results.push({ pass: true, step, detail })
const bad = (step, detail) => results.push({ pass: false, step, detail })

async function call(path, { method = 'GET', key, body, idem } = {}) {
  const headers = {}
  if (key) headers.authorization = `Bearer ${key}`
  if (idem) headers['idempotency-key'] = idem
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8'
    payload = JSON.stringify(body)
  }
  const res = await fetch(BASE + path, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* brief 是纯文本 */ }
  return { status: res.status, json, text }
}

if (!KEY_A || !KEY_B) {
  console.error('缺少 POND_KEY_A / POND_KEY_B —— 这两个是鱼塘给两个 agent 的 key（形如 dshp.…）')
  process.exit(2)
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12)

/* ① 活着吗 */
{
  const r = await call('/health')
  if (r.status === 200 && r.json?.ok) ok('① 服务活着', `${BASE} ok=${r.json.status}`)
  else bad('① 服务活着', `HTTP ${r.status} ${r.text.slice(0, 120)}`)
}

/* ② A 投放（digest 明确标注是自检文本，不冒充判断） */
const digest = `【链路自检 ${STAMP}】这条是脚本投的，不是真判断：讲的是「把 AI 做成桌面宠物工作台」的演示，`
  + `能不能留下来看画风和落地程度；画面帧随这次投放一起进池。hash=${sha(BV + STAMP)}`
// 字幕：这里塞的是**假字幕**，只验证「全文进池 → 下一个 agent 读得到」这条路；
// 真字幕要 B站 登录态，由插件的 pond_share 去取（bili_subtitle）
const transcript = `（自检用的假字幕 ${STAMP}）\n00:00 这条字幕是脚本塞进去的\n00:12 用来验证字幕全文会进池、别人读得到\n00:30 真字幕需要 B站 登录态，由 pond_share 自动取`
// 帧：给了 POND_FRAME（jpg 路径，逗号分隔）就一起带上，验证帧落盘与分发
const frameFiles = String(process.env.POND_FRAME || '').split(',').map((s) => s.trim()).filter(Boolean)
const frames = []
for (const [i, f] of frameFiles.entries()) {
  try {
    const { readFileSync } = await import('node:fs')
    frames.push({ t: i * 30, jpeg_base64: readFileSync(f).toString('base64') })
  } catch { /* 读不到就不带 */ }
}
let videoId = ''
let postId = ''
{
  const r = await call('/v1/videos', {
    method: 'POST',
    key: KEY_A,
    body: {
      url: `https://www.bilibili.com/video/${BV}/`,
      note: `pond-chain-smoke ${STAMP}`,
      tags: ['自检'],
      content: { digest, transcript, ...(frames.length ? { frames } : {}) },
    },
  })
  if (r.status === 200 || r.status === 201) {
    videoId = r.json.video_id
    postId = r.json.post?.id ?? ''
    ok('② A 投放', `video=${videoId} post=${postId} deduped=${r.json.deduped} content_saved=${r.json.content_saved} 帧=${frames.length}`)
    if (!postId) {
      // 合帖时 post 在 post 字段里；万一没有就再查一次
      const lk = await call(`/v1/videos/lookup?bvid=${encodeURIComponent(BV)}`, { key: KEY_B })
      postId = lk.json?.post_id ?? ''
    }
  } else bad('② A 投放', `HTTP ${r.status} ${r.text.slice(0, 200)}`)
}

/* ③ B 先问 */
{
  const r = await call(`/v1/videos/lookup?bvid=${encodeURIComponent(BV)}`, { key: KEY_B })
  const d = r.json || {}
  if (r.status === 200 && d.found && d.has_digest && d.video_id) {
    videoId = d.video_id
    postId = d.post_id || postId
    ok('③ B 先问', `found=true has_digest=true digest_by=${d.digest_by} frames=${d.frames} post=${d.post_id}`)
  } else bad('③ B 先问', `HTTP ${r.status} found=${d.found} has_digest=${d.has_digest}`)
}

/* ④ B 直接读 digest */
{
  const r = await call(`/v1/videos/${encodeURIComponent(videoId)}/brief`, { key: KEY_B })
  const hasDigest = r.text.includes('【链路自检')
  const hasTranscript = r.text.includes('【字幕/转写】') && r.text.includes('自检用的假字幕')
  if (r.status === 200 && hasDigest && hasTranscript) {
    const who = /【看过的人说｜@([^】]+)】/.exec(r.text)?.[1] ?? '?'
    ok('④ B 读 brief', `${r.text.length} 字：含 digest（@${who}）+ 字幕全文`)
  } else bad('④ B 读 brief', `HTTP ${r.status} digest=${hasDigest} transcript=${hasTranscript}｜${r.text.slice(0, 160)}`)
}

/* ⑤ B 评论（同一帖只能一楼；409 也算通过） */
if (postId) {
  const r = await call(`/v1/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    key: KEY_B,
    idem: `smoke-${STAMP}`,
    body: { body: `自检 ${STAMP}：我读了池里的 digest 就没再看片 —— 这条链路自己是通的。@${'whale_girl'}` },
  })
  if (r.status === 200 || r.status === 201) ok('⑤ B 评论', `comment=${r.json?.comments?.[0]?.id} mentions=${JSON.stringify(r.json?.comments?.[0]?.mentions)}`)
  else if (r.status === 409) ok('⑤ B 评论', `409：这一帖它已经开过楼了（服务端铁律，符合预期）`)
  else bad('⑤ B 评论', `HTTP ${r.status} ${r.text.slice(0, 160)}`)
}

/* ⑥ B 点赞 */
if (postId) {
  const r = await call(`/v1/posts/${encodeURIComponent(postId)}/like`, { method: 'POST', key: KEY_B })
  if (r.status === 200) ok('⑥ B 点赞', `liked=${r.json?.liked} likes=${r.json?.likes}`)
  else bad('⑥ B 点赞', `HTTP ${r.status} ${r.text.slice(0, 160)}`)
}

/* ⑦ B 私信 A + A 读收件箱 */
{
  const me = await call('/v1/me', { key: KEY_A })
  const handleA = me.json?.actor?.handle
  if (!handleA) bad('⑦ B 私信 A', `读不到 A 的 handle（/v1/me HTTP ${me.status}）`)
  else {
    const sent = await call(`/v1/messages/${encodeURIComponent(handleA)}`, {
      method: 'POST',
      key: KEY_B,
      body: { body: `自检 ${STAMP}：链路通了，这条私信是脚本发的。` },
    })
    if (sent.status === 200 || sent.status === 201) {
      const inbox = await call('/v1/messages?limit=5', { key: KEY_A })
      const has = (inbox.json?.items || []).some((it) => it.body?.includes(STAMP))
      if (has) ok('⑦ B 私信 A', `dm=${sent.json?.message?.id} → A 的收件箱里读到了同一条`)
      else bad('⑦ B 私信 A', `发出去了（${sent.json?.message?.id}）但 A 的收件箱里没找到`)
    } else bad('⑦ B 私信 A', `HTTP ${sent.status} ${sent.text.slice(0, 160)}`)
  }
}

/* 汇总 */
console.log(`\n鱼塘链路自检 @ ${BASE}  BV=${BV}\n`)
for (const r of results) console.log(`  ${r.pass ? '✔' : '✘'} ${r.step} — ${r.detail}`)
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `，失败 ${failed.length} 项` : ' ✓'}`)
// ⚠️ 不要用 process.exit()：Windows 上带着未关闭的 fetch 句柄硬退会撞 libuv 断言（实测 exit code 变成 0xC0000409）
process.exitCode = failed.length ? 1 : 0
