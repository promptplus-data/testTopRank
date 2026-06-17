import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

// Simple in-memory token cache (per Edge instance)
let tokenCache: { token: string; exp: number } | null = null

function pemToBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let s = ''
  bytes.forEach((b) => (s += String.fromCharCode(b)))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function fetchAccessToken(email: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claim = b64url(
    new TextEncoder().encode(
      JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
    )
  )

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claim}`)
  )

  const jwt = `${header}.${claim}.${b64url(sig)}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const json = await res.json() as { access_token?: string; error?: string }
  if (!json.access_token) throw new Error(json.error ?? 'token exchange failed')
  return json.access_token
}

async function getToken(email: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (tokenCache && tokenCache.exp > now + 120) return tokenCache.token
  const token = await fetchAccessToken(email, privateKey)
  tokenCache = { token, exp: now + 3600 }
  return token
}

async function resolveSheetName(
  sheetId: string,
  gid: string,
  token: string
): Promise<string> {
  const res = await fetch(
    `${SHEETS_BASE}/${sheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return 'Sheet1'
  const data = await res.json() as {
    sheets: { properties: { sheetId: number; title: string } }[]
  }
  return (
    data.sheets.find((s) => String(s.properties.sheetId) === gid)?.properties.title ?? 'Sheet1'
  )
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim()
  if (!id) return NextResponse.json({ error: 'กรุณาระบุ ID' }, { status: 400 })

  const SHEET_ID = process.env.GOOGLE_SHEET_ID
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const SA_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const SHEET_GID = process.env.SHEET_GID
  const SHEET_NAME = process.env.SHEET_NAME
  const ID_COL = Number(process.env.ID_COLUMN_INDEX ?? '0')

  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
    return NextResponse.json(
      { error: 'ยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY' },
      { status: 500 }
    )
  }

  try {
    const token = await getToken(SA_EMAIL, SA_KEY)

    const tabName =
      SHEET_NAME ?? (SHEET_GID ? await resolveSheetName(SHEET_ID, SHEET_GID, token) : 'Sheet1')

    const res = await fetch(
      `${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(tabName)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        next: { revalidate: 60 },
      } as RequestInit
    )

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? 60)
      return NextResponse.json(
        { error: 'rate_limited', retryAfter },
        { status: 429 }
      )
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return NextResponse.json(
        { error: `Google Sheets API: ${body.error?.message ?? res.status}` },
        { status: 502 }
      )
    }

    const data = await res.json() as { values?: string[][] }
    const rows = data.values ?? []

    if (rows.length < 2) return NextResponse.json({ result: null })

    const headers = rows[0]
    const match = rows
      .slice(1)
      .find((row) => row[ID_COL]?.toString().trim().toLowerCase() === id.toLowerCase())

    if (!match) return NextResponse.json({ result: null })

    const result: Record<string, string> = {}
    headers.forEach((h, i) => { result[h] = match[i] ?? '' })

    return NextResponse.json({ result })
  } catch (err) {
    console.error('search error:', err)
    return NextResponse.json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' }, { status: 500 })
  }
}
