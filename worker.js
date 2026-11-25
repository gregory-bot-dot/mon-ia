
// AI HUB — WORKER SECURISE
// Authentification Firebase + Proxy OpenRouter + sauvegarde KV

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const FIREBASE_LOOKUP =
  "https://identitytoolkit.googleapis.com/v1/accounts:lookup";

const SYSTEM_PROMPT =
  "Tu es AI HUB, un assistant personnel. Réponds en français, sauf si l'utilisateur écrit dans une autre langue. " +
  "Va droit au but, sois clair et concis. Utilise le format Markdown quand cela aide. " +
  "Si tu ne sais pas, dis-le au lieu d'inventer.";

const MAX_MESSAGES = 20;
const MAX_BODY_SIZE = 8_000_000;

const MODELS = {
  auto: ["openrouter/free"],
  nemotron: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/free"
  ],
  gemma: [
    "google/gemma-4-26b-a4b-it:free",
    "openrouter/free"
  ],
  ernie: [
    "baidu/ernie-5.5-flash-preview:free",
    "openrouter/free"
  ],
  code: [
    "particle-ai/particle-1:free",
    "openrouter/free"
  ],
  vision: [
    "nvidia/nemotron-3.5-super-vl:free",
    "google/gemma-4-26b-a4b-it:free",
    "openrouter/free"
  ]
};

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN;

  if (origin && allowed && origin === allowed) {
    return {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
  }

  return {};
}

async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { ok: false, status: 401, error: "Connexion requise." };
  }

  if (
    !env.FIREBASE_API_KEY ||
    !env.FIREBASE_PROJECT_ID ||
    !env.FIREBASE_ALLOWED_UID
  ) {
    return {
      ok: false,
      status: 500,
      error: "Configuration Firebase incomplète."
    };
  }

  try {
    const response = await fetch(
      FIREBASE_LOOKUP + "?key=" +
      encodeURIComponent(env.FIREBASE_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: match[1] })
      }
    );

    if (!response.ok) {
      return { ok: false, status: 401, error: "Session Firebase invalide." };
    }

    const result = await response.json();
    const user = result.users && result.users[0];

    if (!user || user.localId !== env.FIREBASE_ALLOWED_UID) {
      return { ok: false, status: 403, error: "Accès non autorisé." };
    }

    return { ok: true, user };
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Vérification Firebase momentanément indisponible."
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");

    if (
      origin &&
      env.ALLOWED_ORIGIN &&
      origin !== env.ALLOWED_ORIGIN
    ) {
      return json({ error: "Origine non autorisée." }, 403);
    }

    if (request.method === "OPTIONS") {
      if (!origin || !env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    // Toutes les routes nécessitent une authentification.
    const auth = await authenticate(request, env);

    if (!auth.ok) {
      return json({ error: auth.error }, auth.status, cors);
    }

    // Sauvegarde cloud : nécessite une base KV configurée.
    if (url.pathname === "/backup") {
      if (!env.AI_HUB_BACKUP) {
        return json(
          { error: "Sauvegarde cloud non configurée." },
          503,
          cors
        );
      }

      if (request.method === "GET") {
        const data = await env.AI_HUB_BACKUP.get("sessions");
        return new Response(data || "[]", {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...cors
          }
        });
      }

      if (request.method === "POST") {
        try {
          const body = await request.json();

          if (body.data === undefined) {
            return json({ error: "Données manquantes." }, 400, cors);
          }

          await env.AI_HUB_BACKUP.put(
            "sessions",
            typeof body.data === "string"
              ? body.data
              : JSON.stringify(body.data)
          );

          return json({ success: true }, 200, cors);
        } catch {
          return json({ error: "Erreur de sauvegarde." }, 400, cors);
        }
      }

      return json({ error: "Méthode non autorisée." }, 405, cors);
    }

    // Proxy OpenRouter.
    if (url.pathname !== "/" || request.method !== "POST") {
      return json({ error: "Route ou méthode non autorisée." }, 404, cors);
    }

    if (!env["Ai-Hub"]) {
      return json({ error: "Clé OpenRouter absente." }, 500, cors);
    }

    const length = Number(request.headers.get("Content-Length") || 0);

    if (length > MAX_BODY_SIZE) {
      return json({ error: "Requête trop volumineuse." }, 413, cors);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON invalide." }, 400, cors);
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      return json({ error: "Aucun message reçu." }, 400, cors);
    }

    const recent = body.messages
  .filter(m =>
    m &&
    ["user", "assistant"].includes(m.role) &&
    (
      typeof m.content === "string" ||
      (
        Array.isArray(m.content) &&
        m.content.length > 0 &&
        m.content.every(part =>
          part &&
          (
            (part.type === "text" && typeof part.text === "string") ||
            (
              part.type === "image_url" &&
              part.image_url &&
              typeof part.image_url.url === "string" &&
              part.image_url.url.startsWith("data:image/")
            )
          )
        )
      )
    )
  )
  .slice(-MAX_MESSAGES);

if (recent.length === 0) {
  return json({ error: "Messages invalides." }, 400, cors);
}
      return json({ error: "Messages invalides." }, 400, cors);
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...recent
    ];

    const mode = MODELS[body.mode] ? body.mode : "auto";
    const stream = body.stream !== false;

    let lastError = "Aucun modèle disponible.";

    for (const model of MODELS[mode]) {
      try {
        const upstream = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env["Ai-Hub"],
            "Content-Type": "application/json",
            "X-Title": "AI HUB"
          },
          body: JSON.stringify({ model, messages, stream })
        });

        if (upstream.ok) {
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "Content-Type":
                upstream.headers.get("Content-Type") ||
                (stream ? "text/event-stream" : "application/json"),
              "Cache-Control": "no-cache",
              ...cors
            }
          });
        }

        const error = await upstream.text();
        lastError = error.slice(0, 500) ||
          "Erreur OpenRouter HTTP " + upstream.status;
      } catch {
        lastError = "Connexion à OpenRouter impossible.";
      }
    }

    return json({ error: lastError }, 502, cors);
  }
};

