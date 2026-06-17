"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface SearchResult {
  [key: string]: string;
}

type Status = "idle" | "loading" | "found" | "not_found" | "error" | "rate_limited";

export default function Home() {
  const [id, setId] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastId, setLastId] = useState("");
  const [countdown, setCountdown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const doSearch = useCallback(async (searchId: string) => {
    setStatus("loading");
    setResult(null);
    setErrorMsg("");
    setLastId(searchId);

    try {
      const res = await fetch(`/api/search?id=${encodeURIComponent(searchId)}`);
      const data = await res.json();

      if (res.status === 429) {
        const wait = data.retryAfter ?? 60;
        setCountdown(wait);
        setStatus("rate_limited");

        // Countdown ticker
        let remaining = wait;
        const tick = setInterval(() => {
          remaining -= 1;
          setCountdown(remaining);
          if (remaining <= 0) clearInterval(tick);
        }, 1000);

        // Auto-retry after wait
        retryTimerRef.current = setTimeout(() => {
          clearInterval(tick);
          doSearch(searchId);
        }, wait * 1000);

        return;
      }

      if (!res.ok) {
        setErrorMsg(data.error || "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
        setStatus("error");
        return;
      }

      if (data.result) {
        setResult(data.result);
        setStatus("found");
      } else {
        setStatus("not_found");
      }
    } catch {
      setErrorMsg("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง");
      setStatus("error");
    }
  }, []);

  const handleSearch = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    await doSearch(trimmed);
  };

  const handleReset = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    setId("");
    setStatus("idle");
    setResult(null);
    setLastId("");
    setCountdown(0);
    inputRef.current?.focus();
  };

  const isRateLimited = status === "rate_limited";

  return (
    <div className="page">
      <div className="card">
        {/* Header */}
        <div className="card-header">
          <span className="icon">🔍</span>
          <h1>ค้นหาข้อมูล</h1>
          <p>Search Data from Google Sheet</p>
        </div>

        {/* Body */}
        <div className="card-body">
          <form onSubmit={handleSearch} noValidate>
            <div className="form-group">
              <label htmlFor="search-id" className="form-label">
                รหัส ID <span>*</span>
              </label>
              <div className="input-wrapper">
                <span className="input-icon">🪪</span>
                <input
                  ref={inputRef}
                  id="search-id"
                  type="text"
                  className="form-input"
                  placeholder="กรอก ID เช่น 001, EMP0042"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  disabled={status === "loading" || isRateLimited}
                  autoComplete="off"
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn-search"
              disabled={status === "loading" || isRateLimited || !id.trim()}
            >
              {status === "loading" ? (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: 16,
                      height: 16,
                      border: "2px solid rgba(255,255,255,0.4)",
                      borderTopColor: "#fff",
                      borderRadius: "50%",
                      animation: "spin 0.7s linear infinite",
                    }}
                  />
                  กำลังค้นหา...
                </>
              ) : (
                <>🔎 ค้นหาข้อมูล</>
              )}
            </button>
          </form>

          {/* Loading */}
          {status === "loading" && (
            <div className="loading-box">
              <div className="spinner" />
              <p>กำลังดึงข้อมูล...</p>
            </div>
          )}

          {/* Rate limited */}
          {isRateLimited && (
            <>
              <hr className="divider" />
              <div className="alert alert-rate-limit">
                <span className="alert-icon">⏳</span>
                <div>
                  <p>
                    <strong>ระบบถูกใช้งานมากเกินไป</strong>
                  </p>
                  <p style={{ marginTop: "0.25rem" }}>
                    กำลังลองใหม่อัตโนมัติใน{" "}
                    <strong
                      style={{
                        fontSize: "1.25rem",
                        color: "#92400e",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {countdown}
                    </strong>{" "}
                    วินาที
                  </p>
                  <button
                    type="button"
                    onClick={handleReset}
                    style={{
                      marginTop: "0.625rem",
                      padding: "0.25rem 0.75rem",
                      background: "transparent",
                      border: "1px solid #d97706",
                      borderRadius: 6,
                      cursor: "pointer",
                      color: "#92400e",
                      fontSize: "0.8rem",
                      fontWeight: 500,
                    }}
                  >
                    ยกเลิก
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Error */}
          {status === "error" && (
            <>
              <hr className="divider" />
              <div className="alert alert-error">
                <span className="alert-icon">⚠️</span>
                <p>{errorMsg}</p>
              </div>
            </>
          )}

          {/* Not found */}
          {status === "not_found" && (
            <>
              <hr className="divider" />
              <div className="alert alert-empty">
                <span className="alert-icon">🔎</span>
                <p>
                  ไม่พบข้อมูลสำหรับ ID: <strong>&ldquo;{lastId}&rdquo;</strong>
                  <br />
                  <small>กรุณาตรวจสอบรหัสแล้วลองใหม่อีกครั้ง</small>
                </p>
              </div>
            </>
          )}

          {/* Found */}
          {status === "found" && result && (
            <>
              <hr className="divider" />
              <div className="result-box">
                <div className="result-box-header">
                  <span>✅</span>
                  <span>พบข้อมูล</span>
                  <span style={{ marginLeft: "auto", fontWeight: 400, opacity: 0.7 }}>
                    ID: {lastId}
                  </span>
                </div>
                <table className="result-table">
                  <tbody>
                    {Object.entries(result).map(([key, val]) => (
                      <tr key={key}>
                        <td>{key}</td>
                        <td>{val || <em style={{ opacity: 0.4 }}>-</em>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button
                type="button"
                onClick={handleReset}
                style={{
                  marginTop: "1rem",
                  width: "100%",
                  padding: "0.625rem",
                  background: "transparent",
                  border: "1.5px solid #d1d5db",
                  borderRadius: 8,
                  cursor: "pointer",
                  color: "#6b7280",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                  transition: "border-color 0.15s, color 0.15s",
                }}
                onMouseOver={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a56db";
                  (e.currentTarget as HTMLButtonElement).style.color = "#1a56db";
                }}
                onMouseOut={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = "#d1d5db";
                  (e.currentTarget as HTMLButtonElement).style.color = "#6b7280";
                }}
              >
                🔄 ค้นหาใหม่
              </button>
            </>
          )}
        </div>
      </div>

      <p className="footer-note">
        ข้อมูลอัปเดตจาก Google Sheet · Powered by Next.js & Vercel
      </p>
    </div>
  );
}
