/// <reference types="@cloudflare/workers-types" />

import { createRemoteJWKSet, jwtVerify } from "jose";

type Env = {
  ASSETS: Fetcher;
  AI: Ai;
  DB: D1Database;
  CONFIG: KVNamespace;
  CLOUDFLARE_API_TOKEN: string;
  USER_HASH_SALT: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ENVIRONMENT: string;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ModelPolicy = {
  default: string[];
  teams: Record<string, string[]>;
};

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const FALLBACK_POLICY: ModelPolicy = {
  default: [DEFAULT_MODEL],
  teams: {
    internal: [
      DEFAULT_MODEL,
      "@cf/meta/llama-3.1-8b-instruct",
      "openai/gpt-4.1-mini",
      "anthropic/claude-sonnet-4"
    ]
  }
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getAccessUser(request: Request, env: Env) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("Missing Cloudflare Access JWT");

  let jwks = jwksCache.get(env.TEAM_DOMAIN);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)
    );
    jwksCache.set(env.TEAM_DOMAIN, jwks);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.TEAM_DOMAIN,
    audience: env.POLICY_AUD
  });

  const email = String(payload.email ?? "");
  if (!email) throw new Error("Missing email claim");

  const userHash = await sha256Hex(`${email}:${env.USER_HASH_SALT}`);

  return {
    email,
    hash: userHash,
    sub: String(payload.sub ?? ""),
    team: email.endsWith("@twister5.com.tw") ? "internal" : "default"
  };
}

async function getModelPolicy(env: Env): Promise<ModelPolicy> {
  const raw = (await env.CONFIG.get("model_policy", "json")) as ModelPolicy | null;
  return raw ?? FALLBACK_POLICY;
}

async function allowedModelsFor(env: Env, team: string): Promise<string[]> {
  const policy = await getModelPolicy(env);
  return policy.teams[team] ?? policy.default;
}

function providerFromModel(model: string) {
  if (model.startsWith("@cf/")) return "workers-ai";
  return model.split("/")[0] || "unknown";
}

async function writeAudit(
  env: Env,
  record: {
    id: string;
    userEmail: string;
    userHash: string;
    userSub: string;
    team: string;
    provider: string;
    model: string;
    promptChars: number;
    status: string;
    errorMessage?: string;
    clientIp: string;
    country: string;
  }
) {
  await env.DB.prepare(
    `
    INSERT INTO ai_audit_logs (
      id, created_at, user_email, user_hash, user_sub, team,
      provider, model, gateway_id, prompt_chars, status,
      error_message, client_ip, country
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  )
    .bind(
      record.id,
      new Date().toISOString(),
      record.userEmail,
      record.userHash,
      record.userSub,
      record.team,
      record.provider,
      record.model,
      env.AI_GATEWAY_ID,
      record.promptChars,
      record.status,
      record.errorMessage ?? null,
      record.clientIp,
      record.country
    )
    .run();
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext) {
  const user = await getAccessUser(request, env);
  const body = (await request.json()) as {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    stream?: boolean;
  };

  const allowed = await allowedModelsFor(env, user.team);
  if (!allowed.includes("*") && !allowed.includes(body.model)) {
    return json({ error: "Model not allowed" }, 403);
  }

  const requestId = crypto.randomUUID();
  const promptChars = JSON.stringify(body.messages).length;
  const provider = providerFromModel(body.model);
  const clientIp = request.headers.get("cf-connecting-ip") ?? "";
  const country = request.headers.get("cf-ipcountry") ?? "";
  const wantStream = body.stream ?? true;

  const metadata = {
    user: user.email,
    team: user.team,
    app: "internal-ai-gui",
    env: env.ENVIRONMENT,
    policy: "standard"
  };

  const audit = (status: string, errorMessage?: string) =>
    ctx.waitUntil(
      writeAudit(env, {
        id: requestId,
        userEmail: user.email,
        userHash: user.hash,
        userSub: user.sub,
        team: user.team,
        provider,
        model: body.model,
        promptChars,
        status,
        errorMessage,
        clientIp,
        country
      })
    );

  try {
    // ---- Workers AI models (@cf/...) ----
    if (body.model.startsWith("@cf/")) {
      if (wantStream) {
        const stream = (await env.AI.run(
          body.model as Parameters<Ai["run"]>[0],
          { messages: body.messages, stream: true },
          {
            gateway: {
              id: env.AI_GATEWAY_ID,
              metadata,
              collectLog: true
            }
          }
        )) as unknown as ReadableStream;

        audit("200-stream");

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            "X-Request-Id": requestId,
            "X-Stream-Format": "workers-ai"
          }
        });
      }

      const result = await env.AI.run(
        body.model as Parameters<Ai["run"]>[0],
        { messages: body.messages },
        {
          gateway: {
            id: env.AI_GATEWAY_ID,
            metadata,
            collectLog: true
          }
        }
      );

      audit("200");
      return json({ id: requestId, result });
    }

    // ---- Third-party models via AI Gateway REST API ----
    const upstream = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
          "cf-aig-gateway-id": env.AI_GATEWAY_ID,
          "cf-aig-collect-log": "true",
          "cf-aig-metadata": JSON.stringify(metadata)
        },
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          stream: wantStream
        })
      }
    );

    audit(String(upstream.status));

    if (wantStream && upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Request-Id": requestId,
          "X-Stream-Format": "openai"
        }
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Request-Id": requestId
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    audit("error", message);
    return json({ error: message }, 500);
  }
}

async function handleSessionsApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  // GET /api/sessions -> 列出目前使用者的會話（不含訊息內容）
  if (url.pathname === "/api/sessions" && request.method === "GET") {
    const user = await getAccessUser(request, env);
    const { results } = await env.DB.prepare(
      `SELECT id, title, model, updated_at
       FROM ai_sessions
       WHERE user_hash = ?
       ORDER BY updated_at DESC
       LIMIT 100`
    )
      .bind(user.hash)
      .all();
    return json({ sessions: results });
  }

  const match = url.pathname.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})$/);
  if (!match) return null;

  const user = await getAccessUser(request, env);
  const sessionId = match[1];

  // GET /api/sessions/:id -> 取得完整會話（含訊息）
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      `SELECT id, title, model, messages, updated_at
       FROM ai_sessions
       WHERE id = ? AND user_hash = ?`
    )
      .bind(sessionId, user.hash)
      .first();

    if (!row) return json({ error: "Session not found" }, 404);

    return json({
      id: row.id,
      title: row.title,
      model: row.model,
      updated_at: row.updated_at,
      messages: JSON.parse(String(row.messages))
    });
  }

  // PUT /api/sessions/:id -> 建立或更新會話
  if (request.method === "PUT") {
    const body = (await request.json()) as {
      title?: string;
      model?: string;
      messages?: unknown[];
    };

    const messagesJson = JSON.stringify(body.messages ?? []);
    if (messagesJson.length > 200_000) {
      return json({ error: "Session too large" }, 413);
    }

    const now = new Date().toISOString();

    // ON CONFLICT 的 WHERE 條件確保無法覆寫其他使用者的會話 id
    await env.DB.prepare(
      `INSERT INTO ai_sessions
         (id, user_hash, title, model, messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         model = excluded.model,
         messages = excluded.messages,
         updated_at = excluded.updated_at
       WHERE ai_sessions.user_hash = excluded.user_hash`
    )
      .bind(
        sessionId,
        user.hash,
        (body.title || "新對話").slice(0, 60),
        body.model ?? DEFAULT_MODEL,
        messagesJson,
        now,
        now
      )
      .run();

    return json({ ok: true });
  }

  // DELETE /api/sessions/:id -> 刪除會話
  if (request.method === "DELETE") {
    await env.DB.prepare(
      `DELETE FROM ai_sessions WHERE id = ? AND user_hash = ?`
    )
      .bind(sessionId, user.hash)
      .run();
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/me") {
        const user = await getAccessUser(request, env);
        return json({ email: user.email, team: user.team });
      }

      if (url.pathname === "/api/models") {
        const user = await getAccessUser(request, env);
        const models = await allowedModelsFor(env, user.team);
        return json({
          defaultModel: models.includes(DEFAULT_MODEL)
            ? DEFAULT_MODEL
            : models[0],
          models
        });
      }

      const sessionsResponse = await handleSessionsApi(request, env, url);
      if (sessionsResponse) return sessionsResponse;

      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env, ctx);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized";
      if (url.pathname.startsWith("/api/")) {
        return json({ error: message }, 401);
      }
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
