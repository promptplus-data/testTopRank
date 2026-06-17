'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────
interface RankEntry { rank: number; name: string; amount: number; isTarget: boolean }
interface CategoryResult { id: string; name: string; province: string; changfamilyPoints: number; storeRank: number; storeAmount: number; entries: RankEntry[] }
interface RankResult {
  storeId: string; storeCode: string; storeName: string; regionName: string; generatedAt: string
  overall: { changfamilyPoints: number; storeRank: number; storeAmount: number; entries: RankEntry[] }
  categories: CategoryResult[]
}
type Status = 'idle' | 'loading' | 'found' | 'not_found' | 'error' | 'rate_limited'

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString()

function RankBadge({ rank, isTarget }: { rank: number; isTarget: boolean }) {
  const cls = isTarget ? 'rb rb-t' : rank === 1 ? 'rb rb-1' : rank === 2 ? 'rb rb-2' : rank === 3 ? 'rb rb-3' : rank <= 5 ? 'rb rb-45' : 'rb rb-n'
  return <span className={cls}>#{rank}</span>
}

function RankRow({ e, separator }: { e: RankEntry; separator?: boolean }) {
  return (
    <div className={`rank-row${e.isTarget ? ' target' : ''}${separator ? ' separator' : ''}`}>
      <RankBadge rank={e.rank} isTarget={e.isTarget} />
      <span className="rank-name">{e.name}</span>
      <span className="rank-amount">{fmt(e.amount)}</span>
    </div>
  )
}

function CfBanner({ points, label }: { points: number; label: string }) {
  return points > 0 ? (
    <div className="cf-banner cf-gold">
      <span>{label}</span>
      <span className="cf-points">{fmt(points)} คะแนน</span>
    </div>
  ) : (
    <div className="cf-banner cf-gray">
      <span>{label}</span>
      <span style={{ color: '#9CA3AF', fontSize: '0.78rem' }}>คุณยังไม่ติดอันดับ</span>
    </div>
  )
}

function OverallSection({ data, regionName }: { data: RankResult['overall']; regionName: string }) {
  const top10 = data.entries.filter(e => e.rank <= 10)
  const storeExtra = data.entries.find(e => e.isTarget && e.rank > 10)
  const left  = top10.filter(e => e.rank <= 5)
  const right = top10.filter(e => e.rank > 5)

  return (
    <div className="section">
      <div className="section-title">📍 Top Rank รวม {regionName}</div>
      <CfBanner points={data.changfamilyPoints} label="Changfamily พิเศษที่คุณได้รับ" />
      <div className="rank-grid">
        <div className="rank-grid-col">{left.map(e => <RankRow key={e.rank} e={e} />)}</div>
        <div className="rank-grid-col">{right.map(e => <RankRow key={e.rank} e={e} />)}</div>
      </div>
      {storeExtra && <RankRow e={storeExtra} separator />}
    </div>
  )
}

const CAT_ICON: Record<string, string> = { cement: '🏗️', housing: '🏠' }

function CategorySection({ cat }: { cat: CategoryResult }) {
  const icon = CAT_ICON[cat.id] ?? '📦'
  const top5 = cat.entries.filter(e => e.rank <= 5)
  const storeExtra = cat.entries.find(e => e.isTarget && e.rank > 5)

  return (
    <div className="section">
      <div className="section-title">{icon} {cat.name} {cat.province}</div>
      <CfBanner points={cat.changfamilyPoints} label="Changfamily พิเศษที่คุณได้รับ" />
      {top5.map(e => <RankRow key={e.rank} e={e} />)}
      {storeExtra && <RankRow e={storeExtra} separator />}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────
export default function Home() {
  const [id, setId] = useState('')
  const [result, setResult] = useState<RankResult | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => () => { if (retryRef.current) clearTimeout(retryRef.current) }, [])

  const doSearch = useCallback(async (searchId: string) => {
    setStatus('loading'); setResult(null); setErrorMsg('')
    try {
      const res = await fetch(`/api/search?id=${encodeURIComponent(searchId)}`)
      const data = await res.json()
      if (res.status === 429) {
        const wait = data.retryAfter ?? 60
        setCountdown(wait); setStatus('rate_limited')
        let rem = wait
        const tick = setInterval(() => { rem--; setCountdown(rem); if (rem <= 0) clearInterval(tick) }, 1000)
        retryRef.current = setTimeout(() => { clearInterval(tick); doSearch(searchId) }, wait * 1000)
        return
      }
      if (!res.ok) { setErrorMsg(data.error || 'เกิดข้อผิดพลาด'); setStatus('error'); return }
      if (data.result) { setResult(data.result); setStatus('found') }
      else setStatus('not_found')
    } catch {
      setErrorMsg('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้'); setStatus('error')
    }
  }, [])

  const handleSearch = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const t = id.trim()
    if (!t) { inputRef.current?.focus(); return }
    if (retryRef.current) clearTimeout(retryRef.current)
    await doSearch(t)
  }

  const handleReset = () => {
    if (retryRef.current) clearTimeout(retryRef.current)
    setId(''); setStatus('idle'); setResult(null); setCountdown(0)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  // ── Result view ───────────────────────────────────────────────────
  if (status === 'found' && result) {
    return (
      <div className="result-page">
        <div className="result-header">
          <div className="result-header-left">
            <span className="header-trophy">🏆</span>
            <div className="header-title">
              <h1>Top Rank Western Big Deal Fair 2026</h1>
              <p>วันที่ 1 – 15 กรกฎาคม 2569</p>
            </div>
          </div>
          <div className="header-store">
            <div className="header-store-label">ร้านของคุณ</div>
            <div className="header-store-name">{result.storeCode} {result.storeName}</div>
          </div>
        </div>

        <div className="result-content">
          <OverallSection data={result.overall} regionName={result.regionName} />
          <div className="cat-grid">
            {result.categories.map(cat => <CategorySection key={cat.id} cat={cat} />)}
          </div>
        </div>

        <div className="result-footer">
          <button className="btn-back" onClick={handleReset}>← ค้นหาใหม่</button>
          <span>Generated: {result.generatedAt}</span>
        </div>
      </div>
    )
  }

  // ── Search view ───────────────────────────────────────────────────
  const isLimited = status === 'rate_limited'
  return (
    <div className="search-page">
      <div className="card">
        <div className="card-header">
          <span className="icon">🏆</span>
          <h1>Top Rank Western Big Deal Fair 2026</h1>
          <p>กรอกรหัสร้านเพื่อดูอันดับของคุณ</p>
        </div>
        <div className="card-body">
          <form onSubmit={handleSearch} noValidate>
            <div className="form-group">
              <label htmlFor="sid" className="form-label">รหัสร้าน <span>*</span></label>
              <div className="input-wrapper">
                <span className="input-icon">🪪</span>
                <input ref={inputRef} id="sid" type="text" className="form-input"
                  placeholder="เช่น BNK001" value={id} onChange={e => setId(e.target.value)}
                  disabled={status === 'loading' || isLimited} autoComplete="off" />
              </div>
            </div>
            <button type="submit" className="btn-search" disabled={status === 'loading' || isLimited || !id.trim()}>
              {status === 'loading' ? <><span className="btn-spinner" />กำลังโหลด...</> : '🔎 ดูอันดับ'}
            </button>
          </form>

          {status === 'loading' && <div className="loading-box"><div className="spinner" /><p>กำลังดึงข้อมูล...</p></div>}

          {status === 'error' && (
            <><hr className="divider" /><div className="alert alert-error"><span className="alert-icon">⚠️</span><p>{errorMsg}</p></div></>
          )}
          {status === 'not_found' && (
            <><hr className="divider" /><div className="alert alert-empty"><span className="alert-icon">🔎</span><p>ไม่พบข้อมูลรหัส <strong>"{id}"</strong></p></div></>
          )}
          {isLimited && (
            <><hr className="divider" /><div className="alert alert-rate-limit">
              <span className="alert-icon">⏳</span>
              <div>
                <p><strong>ระบบถูกใช้งานมากเกินไป</strong></p>
                <p style={{ marginTop: '0.25rem' }}>กำลังลองใหม่ใน <strong style={{ fontSize: '1.2rem', color: '#92400e', fontVariantNumeric: 'tabular-nums' }}>{countdown}</strong> วินาที</p>
                <button onClick={handleReset} style={{ marginTop: '0.5rem', padding: '0.2rem 0.75rem', border: '1px solid #D97706', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: '#92400e', fontSize: '0.8rem' }}>ยกเลิก</button>
              </div>
            </div></>
          )}
        </div>
      </div>
    </div>
  )
}
