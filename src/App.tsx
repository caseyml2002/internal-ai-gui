import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import "./App.css";

/* ---------- Types ---------- */

type Me = { email: string; team: string };

type Msg = {
  role: "user" | "assistant";
  content: string;
  model?: string;
  latencyMs?: number;
  at: number;
};

type Session = {
  id: string;
  title: string;
  model: string;
  messages: Msg[];
  updatedAt: number;
  loaded: boolean; // 訊息是否已從伺服器載入
};

type ModelsResponse = { defaultModel: string; models: string[] };

type SessionListResponse = {
  sessions: Array<{
    id: string;
    title: string;
    model: string;
    updated_at: string;
  }>;
};

type SessionDetailResponse = {
  id: string;
  title: string;
  model: string;
  updated_at: string;
  messages: Msg[];
};

type ChatJson = {
  choices?: Array<{ message?: { content?: string } }>;
  result?: { response?: string };
  error?: string;
};

/* ---------- Model metadata ---------- */

function providerOf(model: string) {
  if (model.startsWith("@cf/")) return "workers-ai";
  return model.split("/")[0] || "other";
}

const PROVIDER_LABEL: Record<string, string> = {
  "workers-ai": "Workers AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter"
};

function modelDisplayName(model: string) {
  const last = model.split("/").pop() ?? model;
  return last
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bIt\b/, "IT")
    .replace(/\bAi\b/, "AI");
}

/* ---------- Lightweight markdown (code blocks / inline code / bold) ---------- */

function renderContent(text: string) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const plain = parts[i];
    if (plain) nodes.push(<InlineText key={`t${i}`} text={plain} />);
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      const code = parts[i + 2];
      nodes.push(
        <pre key={`c${i}`} className="code-block">
          {lang && <span className="code-lang">{lang}</span>}
          <code>{code}</code>
        </pre>
      );
    }
  }
  return nodes;
}

function InlineText({ text }: { text: string }) {
  const segments = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <p className="msg-text">
      {segments.map((seg, i) => {
        if (seg.startsWith("`") && seg.endsWith("`"))
          return <code key={i}>{seg.slice(1, -1)}</code>;
        if (seg.startsWith("**") && seg.endsWith("**"))
          return <strong key={i}>{seg.slice(2, -2)}</strong>;
        return <span key={i}>{seg}</span>;
      })}
    </p>
  );
}

/* ---------- Server persistence helpers ---------- */

async function apiSaveSession(session: {
  id: string;
  title: string;
  model: string;
  messages: Msg[];
}) {
  try {
    await fetch(`/api/sessions/${session.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: session.title,
        model: session.model,
        messages: session.messages.filter((m) => m.content.trim() !== "")
      })
    });
  } catch {
    /* 儲存失敗不阻擋對話，下次儲存會帶上完整內容 */
  }
}

async function apiDeleteSession(id: string) {
  try {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

/* ---------- App ---------- */

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authError, setAuthError] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId]
  );

  /* --- Boot: identity + allowed models + session list --- */
  useEffect(() => {
    void (async () => {
      try {
        const meRes = await fetch("/api/me");
        if (!meRes.ok) throw new Error("unauthorized");
        setMe((await meRes.json()) as Me);
      } catch {
        setAuthError(true);
        return;
      }

      try {
        const [modelsRes, sessRes] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/sessions")
        ]);

        const m = (await modelsRes.json()) as ModelsResponse;
        setModels(m.models);
        setDefaultModel(m.defaultModel);

        const s = (await sessRes.json()) as SessionListResponse;
        const list: Session[] = (s.sessions ?? []).map((r) => ({
          id: r.id,
          title: r.title,
          model: r.model,
          messages: [],
          updatedAt: Date.parse(r.updated_at) || Date.now(),
          loaded: false
        }));

        if (list.length > 0) {
          setSessions(list);
          void openSession(list[0].id);
        } else {
          const first = makeSession(m.defaultModel);
          setSessions([first]);
          setActiveId(first.id);
        }
      } catch {
        // 模型 / 會話清單載入失敗時仍給一個空會話可用
        const first = makeSession("@cf/google/gemma-4-26b-a4b-it");
        setSessions([first]);
        setActiveId(first.id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- Auto scroll --- */
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [active?.messages.length, active?.messages.at(-1)?.content]);

  function makeSession(model?: string): Session {
    const s: Session = {
      id: crypto.randomUUID(),
      title: "新對話",
      model: model || defaultModel || models[0] || "",
      messages: [],
      updatedAt: Date.now(),
      loaded: true // 本地新建，不需要再向伺服器載入
    };
    loadedRef.current.add(s.id);
    return s;
  }

  function createSession() {
    const s = makeSession(active?.model);
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    inputRef.current?.focus();
    // 空會話不立即寫入伺服器，等第一則訊息送出後才持久化
  }

  /* --- 選取會話：未載入訊息時向伺服器取回 --- */
  async function openSession(id: string) {
    setActiveId(id);
    if (loadedRef.current.has(id)) return;
    loadedRef.current.add(id);

    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as SessionDetailResponse;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                title: data.title,
                model: data.model,
                messages: data.messages ?? [],
                loaded: true
              }
            : s
        )
      );
    } catch {
      loadedRef.current.delete(id); // 允許下次重試
    }
  }

  function deleteSession(id: string) {
    void apiDeleteSession(id);
    loadedRef.current.delete(id);
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  function setModel(model: string) {
    if (!active) {
      const s = makeSession(model);
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      return;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === activeId ? { ...s, model } : s))
    );
  }

  function stopStreaming() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;

    let session = active;
    if (!session) {
      session = makeSession();
      const s = session;
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
    }

    const sid = session.id;
    const patchSession = (patch: (s: Session) => Session) =>
      setSessions((prev) => prev.map((s) => (s.id === sid ? patch(s) : s)));

    const userMsg: Msg = { role: "user", content: text, at: Date.now() };
    const history = [...session.messages, userMsg];
    const model = session.model;
    const title =
      session.messages.length === 0 ? text.slice(0, 24) : session.title;
    const started = performance.now();

    // 本地累積完整回覆，串流結束後直接用它持久化，
    // 避免依賴尚未 commit 的 React state
    let assistantText = "";

    setInput("");
    setStreaming(true);

    patchSession((s) => ({
      ...s,
      title,
      messages: [
        ...s.messages,
        userMsg,
        { role: "assistant", content: "", model, at: Date.now() }
      ],
      updatedAt: Date.now()
    }));

    const appendAssistant = (chunk: string, done = false) => {
      patchSession((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        msgs[msgs.length - 1] = {
          ...last,
          content: last.content + chunk,
          latencyMs: done
            ? Math.round(performance.now() - started)
            : last.latencyMs
        };
        return { ...s, messages: msgs, updatedAt: Date.now() };
      });
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: history
            .filter((m) => m.content.trim() !== "")
            .map(({ role, content }) => ({ role, content })),
          stream: true
        })
      });

      const ctype = res.headers.get("Content-Type") ?? "";

      if (!res.ok || !ctype.includes("text/event-stream")) {
        const data = (await res.json()) as ChatJson;
        const content =
          data.choices?.[0]?.message?.content ??
          data.result?.response ??
          data.error ??
          JSON.stringify(data);
        assistantText = content;
        appendAssistant(content, true);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload) as {
              response?: string;
              choices?: Array<{
                delta?: { content?: string; reasoning?: string };
              }>;
            };
            // 同時相容兩種格式：
            // Workers AI 經典格式 -> { response: "..." }
            // OpenAI 相容格式（Gemma 等新模型）-> choices[0].delta.content
            // delta.reasoning 是模型思考過程，不顯示
            const delta =
              obj.response ?? obj.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              assistantText += delta;
              appendAssistant(delta);
            }
          } catch {
            /* partial JSON — wait for more data */
          }
        }
      }
      appendAssistant("", true);

      // 串流結束但完全沒收到內容時，給出明確提示而不是卡在打字動畫
      if (assistantText === "") {
        const fallback = "（未收到模型回應，請重試或更換模型）";
        assistantText = fallback;
        patchSession((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last.role === "assistant" && last.content === "") {
            msgs[msgs.length - 1] = { ...last, content: fallback };
          }
          return { ...s, messages: msgs };
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const errText = `\n\n⚠️ 請求失敗：${(err as Error).message}`;
        assistantText += errText;
        appendAssistant(errText, true);
      } else {
        appendAssistant("", true);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;

      // 用本地累積的內容組出最終訊息並持久化到伺服器（D1）
      const finalMessages: Msg[] = [
        ...history,
        {
          role: "assistant",
          content: assistantText,
          model,
          latencyMs: Math.round(performance.now() - started),
          at: Date.now()
        }
      ];
      void apiSaveSession({ id: sid, title, model, messages: finalMessages });
    }
  }

  function onComposerKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  /* --- Group models by provider for the picker --- */
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of models) {
      const p = providerOf(m);
      map.set(p, [...(map.get(p) ?? []), m]);
    }
    return [...map.entries()];
  }, [models]);

  if (authError) {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="auth-mark">⛨</div>
          <h1>需要 Zero Trust 驗證</h1>
          <p>
            這個入口由 Cloudflare Access 保護。請透過公司核發的
            Zero Trust 網域登入後再開啟此頁面。
          </p>
          <button onClick={() => location.reload()}>重新驗證</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      {/* ---------- Sidebar ---------- */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⛨</span>
          <div>
            <strong>Internal AI</strong>
            <small>Cloudflare Zero Trust Portal</small>
          </div>
        </div>

        <button className="new-chat" onClick={createSession}>
          ＋ 新對話
        </button>

        <nav className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? "active" : ""}`}
              onClick={() => void openSession(s.id)}
            >
              <span className="session-title">{s.title}</span>
              <button
                className="session-delete"
                title="刪除對話"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </nav>

        <div className="identity-card">
          <div className="identity-row">
            <span className="dot dot-ok" />
            <span className="identity-label">Zero Trust 已驗證</span>
            <button
              className="logout-btn"
              title="登出 Zero Trust"
              onClick={() => {
                // Cloudflare Access 登出端點（同網域相對路徑，
                // 換網域部署也不用改）：/cdn-cgi/access/logout
                window.location.href = "/cdn-cgi/access/logout";
              }}
            >
              登出
            </button>
          </div>
          <div className="identity-email">{me?.email ?? "載入中…"}</div>
          <div className="identity-meta">
            <span className="chip">{me?.team ?? "—"}</span>
            <span className="chip chip-muted">會話雲端同步</span>
          </div>
        </div>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="main">
        <header className="topbar">
          <button
            className="icon-btn"
            title="切換側欄"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </button>

          <div className="model-picker">
            <label htmlFor="model">模型</label>
            <select
              id="model"
              value={active?.model ?? ""}
              onChange={(e) => setModel(e.target.value)}
            >
              {grouped.map(([provider, list]) => (
                <optgroup
                  key={provider}
                  label={PROVIDER_LABEL[provider] ?? provider}
                >
                  {list.map((m) => (
                    <option key={m} value={m}>
                      {modelDisplayName(m)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="topbar-right">
            <span className="gateway-badge" title="所有請求經 AI Gateway 記錄">
              AI Gateway · audit on
            </span>
          </div>
        </header>

        <div className="messages" ref={scrollRef}>
          {!active || (active.loaded && active.messages.length === 0) ? (
            <div className="empty">
              <div className="empty-mark">⛨</div>
              <h2>開始一段受稽核的對話</h2>
              <p>
                你的身份已由 Cloudflare Access 驗證，會話只屬於你本人，
                每次請求都會附帶使用者 metadata 送往 AI Gateway 並寫入稽核紀錄。
              </p>
              <div className="empty-hints">
                <button onClick={() => setInput("幫我摘要這段文字：")}>
                  摘要文字
                </button>
                <button onClick={() => setInput("幫我把以下內容翻譯成英文：")}>
                  翻譯內容
                </button>
                <button onClick={() => setInput("解釋這段程式碼的用途：")}>
                  解釋程式碼
                </button>
              </div>
            </div>
          ) : !active.loaded ? (
            <div className="empty">
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : (
            active.messages.map((m, i) => (
              <article key={i} className={`msg ${m.role}`}>
                <div className="avatar">
                  {m.role === "user"
                    ? (me?.email?.[0] ?? "U").toUpperCase()
                    : "AI"}
                </div>
                <div className="bubble">
                  {m.content ? (
                    renderContent(m.content)
                  ) : (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {m.role === "assistant" && m.content && (
                    <div className="msg-meta">
                      {modelDisplayName(m.model ?? "")}
                      {m.latencyMs != null && <> · {m.latencyMs} ms</>}
                      {" · "}
                      {new Date(m.at).toLocaleTimeString("zh-TW", {
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </div>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        <footer className="composer">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="輸入訊息，Enter 送出、Shift+Enter 換行"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
          />
          {streaming ? (
            <button className="send stop" onClick={stopStreaming}>
              ■ 停止
            </button>
          ) : (
            <button
              className="send"
              onClick={() => void send()}
              disabled={!input.trim()}
            >
              送出 ↵
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}
