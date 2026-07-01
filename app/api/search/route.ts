import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// ── Rate Limiter ───────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 10; // max requests per window
const RATE_LIMIT_WINDOW = 60; // window size in seconds
const RATE_LIMIT_BAN_SECS = 300; // ban duration after exceeding limit (5 min)

interface RateEntry {
	count: number;
	windowStart: number;
	bannedUntil?: number;
}
const rateMap = new Map<string, RateEntry>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
	const now = Math.floor(Date.now() / 1000);
	const entry = rateMap.get(ip);

	// Currently banned
	if (entry?.bannedUntil && entry.bannedUntil > now) {
		return { allowed: false, retryAfter: entry.bannedUntil - now };
	}

	// New window or first request
	if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW) {
		rateMap.set(ip, { count: 1, windowStart: now });
		return { allowed: true };
	}

	// Within window — increment
	entry.count++;
	if (entry.count > RATE_LIMIT_MAX) {
		entry.bannedUntil = now + RATE_LIMIT_BAN_SECS;
		return { allowed: false, retryAfter: RATE_LIMIT_BAN_SECS };
	}

	return { allowed: true };
}

// Periodically clean up old entries to avoid unbounded memory growth
let lastCleanup = Date.now();
function maybeCleanup() {
	const now = Date.now();
	if (now - lastCleanup < 60_000) return;
	lastCleanup = now;
	const nowSec = Math.floor(now / 1000);
	for (const [ip, entry] of rateMap) {
		const expired = nowSec - entry.windowStart >= RATE_LIMIT_WINDOW * 2;
		const unbanned = !entry.bannedUntil || entry.bannedUntil <= nowSec;
		if (expired && unbanned) rateMap.delete(ip);
	}
}

const SCOPE = [
	"https://www.googleapis.com/auth/spreadsheets.readonly",
	"https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

let tokenCache: { token: string; exp: number } | null = null;

function pemToBuffer(pem: string): ArrayBuffer {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const bin = atob(b64);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf.buffer;
}

function b64url(data: ArrayBuffer | Uint8Array): string {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	let s = "";
	bytes.forEach((b) => (s += String.fromCharCode(b)));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fetchAccessToken(
	email: string,
	privateKey: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(
		new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
	);
	const claim = b64url(
		new TextEncoder().encode(
			JSON.stringify({
				iss: email,
				scope: SCOPE,
				aud: TOKEN_URL,
				iat: now,
				exp: now + 3600,
			}),
		),
	);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToBuffer(privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${header}.${claim}`),
	);
	const jwt = `${header}.${claim}.${b64url(sig)}`;
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}),
	});
	const json = (await res.json()) as { access_token?: string; error?: string };
	if (!json.access_token)
		throw new Error(json.error ?? "token exchange failed");
	return json.access_token;
}

async function getToken(email: string, privateKey: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (tokenCache && tokenCache.exp > now + 120) return tokenCache.token;
	const token = await fetchAccessToken(email, privateKey);
	tokenCache = { token, exp: now + 3600 };
	return token;
}

async function fetchSheetModifiedTime(
	sheetId: string,
	token: string,
): Promise<string | null> {
	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${sheetId}?fields=modifiedTime`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) return null;
	const data = (await res.json()) as { modifiedTime?: string };
	if (!data.modifiedTime) return null;
	const bkk = new Date(new Date(data.modifiedTime).getTime() + 7 * 60 * 60 * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(bkk.getUTCDate())}-${p(bkk.getUTCMonth() + 1)}-${bkk.getUTCFullYear()} ${p(bkk.getUTCHours())}:${p(bkk.getUTCMinutes())}:${p(bkk.getUTCSeconds())}`;
}

async function resolveSheetName(
	sheetId: string,
	gid: string,
	token: string,
): Promise<string> {
	const res = await fetch(
		`${SHEETS_BASE}/${sheetId}?fields=sheets.properties`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) return "Sheet1";
	const data = (await res.json()) as {
		sheets: { properties: { sheetId: number; title: string } }[];
	};
	return (
		data.sheets.find((s) => String(s.properties.sheetId) === gid)?.properties
			.title ?? "Sheet1"
	);
}

// ── Types ──────────────────────────────────────────────────────────────────
interface RankEntry {
	rank: number;
	name: string;
	amount: number;
	isTarget: boolean;
}
interface CategoryResult {
	id: string;
	name: string;
	limit: number;
	province: string;
	changfamilyPoints: number;
	storeRank: number;
	storeAmount: number;
	entries: RankEntry[];
}
interface SearchResult {
	storeId: string;
	storeCode: string;
	storeName: string;
	regionName: string;
	generatedAt: string;
	dataUpdatedAt?: string;
	overall: {
		changfamilyPoints: number;
		storeRank: number;
		storeAmount: number;
		entries: RankEntry[];
	};
	categories: CategoryResult[];
}

function parseNum(v: string | undefined): number {
	return parseFloat((v ?? "").replace(/,/g, "")) || 0;
}

function rankRows(
	rows: string[][],
	idCol: number,
	nameCol: number,
	amountCol: number,
	targetId: string,
	displayN: number,
	filterProvince?: string,
	provinceCol?: number,
): { entries: RankEntry[]; storeRank: number; storeAmount: number } {
	const tid = targetId.toLowerCase();
	let pool = rows.map((r) => ({
		id: (r[idCol] ?? "").trim(),
		name: r[nameCol] ?? "",
		province: provinceCol != null ? (r[provinceCol] ?? "").trim() : "",
		amount: parseNum(r[amountCol]),
	}));
	if (filterProvince && provinceCol != null) {
		// normalize: strip จ. prefix, lowercase, trim — handles "ชลบุรี" / "จ.ชลบุรี" / "จังหวัดชลบุรี"
		const norm = (s: string) =>
			s
				.toLowerCase()
				.replace(/^จ\.?|^จังหวัด/u, "")
				.trim();
		const target = norm(filterProvince);
		const filtered = pool.filter((c) => norm(c.province) === target);
		// fallback: if nobody else shares the province, skip filter (avoid empty category)
		pool =
			filtered.length > 1 ? filtered : filtered.length === 1 ? filtered : pool;
	}
	const sorted = pool
		.filter((c) => c.amount > 0)
		.sort((a, b) => b.amount - a.amount)
		.map((c, i) => ({ ...c, rank: i + 1 }));
	const store = sorted.find((c) => c.id.toLowerCase() === tid);
	const storeRank = store?.rank ?? 0;
	const storeAmount = store?.amount ?? 0;
	const topN = sorted.slice(0, displayN);
	const entries: RankEntry[] = topN.map((c) => ({
		rank: c.rank,
		name: c.id.toLowerCase() === tid ? c.name : "***",
		amount: c.amount,
		isTarget: c.id.toLowerCase() === tid,
	}));
	if (storeRank > displayN && store) {
		entries.push({
			rank: storeRank,
			name: store.name,
			amount: storeAmount,
			isTarget: true,
		});
	}
	return { entries, storeRank, storeAmount };
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
	// Rate limiting — identify by IP (falls back to 'unknown' in local dev)
	maybeCleanup();
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
		request.headers.get("x-real-ip") ??
		"unknown";
	const rl = checkRateLimit(ip);
	if (!rl.allowed) {
		return NextResponse.json(
			{
				error: "คุณส่งคำขอบ่อยเกินไป กรุณารอแล้วลองใหม่",
				retryAfter: rl.retryAfter,
			},
			{ status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
		);
	}

	const code = request.nextUrl.searchParams.get("code")?.trim();
	const phone = request.nextUrl.searchParams.get("phone")?.trim();
	if (!code)
		return NextResponse.json({ error: "กรุณาระบุรหัสร้าน" }, { status: 400 });
	if (!phone)
		return NextResponse.json(
			{ error: "กรุณาระบุเบอร์โทรศัพท์" },
			{ status: 400 },
		);

	const SHEET_ID = process.env.GOOGLE_SHEET_ID;
	const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
	const SA_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
	const SHEET_GID = process.env.SHEET_GID;
	const SHEET_NAME = process.env.SHEET_NAME;
	const REGION_NAME = process.env.REGION_NAME ?? "ภาคตะวันตก";

	// Column name (or 0-based index) — matches sample-data.csv headers by default
	const C = {
		id: process.env.COL_STORE_ID ?? "StoreID",
		code: process.env.COL_CODE ?? "Code",
		phone: process.env.COL_PHONE ?? "Phone",
		name: process.env.COL_STORE_NAME ?? "StoreName",
		province: process.env.COL_PROVINCE ?? "Province",
		total: process.env.COL_TOTAL_SALES ?? "TotalSales",
		cement: process.env.COL_CEMENT_SALES ?? "CementSales",
		housing: process.env.COL_HOUSING_SALES ?? "HousingSales",
		overallPts: process.env.COL_OVERALL_POINTS ?? "OverallPoints",
		cementPts: process.env.COL_CEMENT_POINTS ?? "CementPoints",
		housingPts: process.env.COL_HOUSING_POINTS ?? "HousingPoints",
	};

	if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
		return NextResponse.json(
			{ error: "ยังไม่ได้ตั้งค่า environment variables" },
			{ status: 500 },
		);
	}

	try {
		const token = await getToken(SA_EMAIL, SA_KEY);
		const dataUpdatedAt = await fetchSheetModifiedTime(SHEET_ID, token);
		const tabName =
			SHEET_NAME ??
			(SHEET_GID
				? await resolveSheetName(SHEET_ID, SHEET_GID, token)
				: "Sheet1");

		const res = await fetch(
			`${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(tabName)}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
				},
				next: { revalidate: 60 },
			} as RequestInit,
		);

		if (res.status === 429) {
			return NextResponse.json(
				{
					error: "rate_limited",
					retryAfter: Number(res.headers.get("Retry-After") ?? 60),
				},
				{ status: 429 },
			);
		}
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: { message?: string };
			};
			return NextResponse.json(
				{ error: `Google Sheets API: ${body.error?.message ?? res.status}` },
				{ status: 502 },
			);
		}

		const allRows =
			((await res.json()) as { values?: string[][] }).values ?? [];
		if (allRows.length < 2) return NextResponse.json({ result: null });

		// Resolve column names → indices from header row
		const headers = allRows[0];
		const colIdx = (nameOrNum: string): number => {
			const n = Number(nameOrNum);
			if (!isNaN(n)) return n;
			const i = headers.indexOf(nameOrNum);
			return i >= 0 ? i : 0;
		};
		const rows = allRows.slice(1);

		// Resolve all column names → numeric indices (after colIdx is defined)
		const ci = {
			id: colIdx(C.id),
			code: colIdx(C.code),
			phone: colIdx(C.phone),
			name: colIdx(C.name),
			province: colIdx(C.province),
			total: colIdx(C.total),
			cement: colIdx(C.cement),
			housing: colIdx(C.housing),
			overallPts: colIdx(C.overallPts),
			cementPts: colIdx(C.cementPts),
			housingPts: colIdx(C.housingPts),
		};

		// Normalize phone: strip leading zeros/spaces for flexible matching
		const normPhone = (s: string) => s.replace(/\D/g, "");
		const inputPhone = normPhone(phone);

		// Find row matching Code AND Phone
		const storeRow = rows.find((r) => {
			const rowCode = (r[ci.code] ?? "").trim().toLowerCase();
			const rowPhone = normPhone(r[ci.phone] ?? "");
			return rowCode === code.toLowerCase() && rowPhone === inputPhone;
		});
		if (!storeRow) return NextResponse.json({ result: null });

		const storeName = storeRow[ci.name] ?? "";
		const storeCode = storeRow[ci.code] ?? code.toUpperCase();
		const storeId = storeRow[ci.id] ?? code.toUpperCase();
		const province = storeRow[ci.province] ?? "";

		const overallRank = rankRows(rows, ci.id, ci.name, ci.total, storeId, 10);
		const cementRank = rankRows(rows, ci.id, ci.name, ci.cement, storeId, 5, province, ci.province);
		const housingRank = rankRows(rows, ci.id, ci.name, ci.housing, storeId, 1, province, ci.province);

		const result: SearchResult = {
			storeId: storeId.toUpperCase(),
			storeCode,
			storeName,
			regionName: REGION_NAME,
			dataUpdatedAt: dataUpdatedAt ?? undefined,
			generatedAt: (() => {
				const now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
				const p = (n: number) => String(n).padStart(2, "0");
				return `${p(now.getUTCDate())}-${p(now.getUTCMonth() + 1)}-${now.getUTCFullYear()} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;
			})(),
			overall: {
				changfamilyPoints: overallRank.storeRank > 0 && overallRank.storeRank <= 10
					? parseNum(storeRow[ci.overallPts])
					: 0,
				...overallRank,
			},
			categories: [
				{
					id: "cement",
					name: "ซีเมนต์",
					province: `จ.${province}`,
					limit: 5,
					changfamilyPoints: cementRank.storeRank > 0 && cementRank.storeRank <= 5
						? parseNum(storeRow[ci.cementPts])
						: 0,
					...cementRank,
				},
				{
					id: "housing",
					name: "หลังคาฝาฝ้า",
					province: `จ.${province}`,
					limit: 1,
					changfamilyPoints: housingRank.storeRank > 0 && housingRank.storeRank <= 1
						? parseNum(storeRow[ci.housingPts])
						: 0,
					...housingRank,
				},
			],
		};

		return NextResponse.json({ result });
	} catch (err) {
		console.error("search error:", err);
		return NextResponse.json(
			{ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" },
			{ status: 500 },
		);
	}
}
