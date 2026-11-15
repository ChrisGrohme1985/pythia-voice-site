// Austauschbarer KI-Anbieter für api/ai.js: Groq (Standard) oder Cloudflare Workers AI (AI_PROVIDER=cloudflare).
// run(p, body, contentType) → { status, text }, text immer im Groq-/OpenAI-Format, wie die App es erwartet.
// Umgebungsvariablen: AI_PROVIDER, GROQ_API_KEY | CF_ACCOUNT_ID, CF_API_TOKEN
// shortcut: Cloudflare-Felder (Denkaufwand, Ergebnisfelder) nach Dokumentation, nicht live geprüft; beim ersten Test mit echtem Konto abgleichen.
module.exports = { run }

async function run(p, body, contentType) {
  const provider = process.env.AI_PROVIDER || "groq"

  if (provider === "cloudflare") {
    return await cf_run(p, body, contentType)
  } else if (provider === "openai") {
    return await oa_run(p, body, contentType)
  } else {
    return await groq_run(p, body, contentType)
  }
}

async function groq_run(p, body, contentType) {
  const key = process.env.GROQ_API_KEY
  if (!key) {
    throw Object.assign(new Error("GROQ_API_KEY fehlt"), { code: "config" })
  }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/" + p, {
      method:"POST",
      headers:{
        Authorization:"Bearer " + key,
        "Content-Type": contentType,
        "User-Agent":"PythiaVoice-Server/1.0"
      },
      body
    })
    return { status: r.status, text: await r.text() }
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: "network" })
  }
}

// Beliebiger OpenAI-kompatibler Anbieter (Fireworks, DeepInfra, OpenAI ...): AI_BASE (z. B. https://api.fireworks.ai/inference/v1), AI_KEY,
// AI_STT_MODEL, AI_LLM_MODEL; optional AI_STT_BASE, falls die Spracherkennung unter anderer Adresse läuft.
async function oa_run(p, body, contentType) {
  const key = process.env.AI_KEY, base = process.env.AI_BASE
  const stt = process.env.AI_STT_MODEL, llm = process.env.AI_LLM_MODEL
  if (!key || !base || !stt || !llm) throw Object.assign(new Error("AI_BASE, AI_KEY, AI_STT_MODEL oder AI_LLM_MODEL fehlt"), { code: "config" })
  let url, out
  if (p === "audio/transcriptions") {
    url = (process.env.AI_STT_BASE || base) + "/audio/transcriptions"
    const old = Buffer.from("\r\n\r\nwhisper-large-v3-turbo\r\n"), i = body.indexOf(old)
    out = i < 0 ? body : Buffer.concat([body.subarray(0, i), Buffer.from("\r\n\r\n" + stt + "\r\n"), body.subarray(i + old.length)])
  } else {
    url = base + "/chat/completions"
    out = JSON.stringify({ ...JSON.parse(body.toString()), model: llm })
  }
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": contentType, "User-Agent": "PythiaVoice-Server/1.0" }, body: out })
    return { status: r.status, text: await r.text() }
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: "network" })
  }
}

async function cf_run(p, body, contentType) {
  const account = process.env.CF_ACCOUNT_ID
  const token = process.env.CF_API_TOKEN
  if (!account || !token) {
    throw Object.assign(new Error("CF_ACCOUNT_ID oder CF_API_TOKEN fehlt"), { code: "config" })
  }

  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`

  if (p === "chat/completions") {
    return await cf_chat(base, body, token)
  } else if (p === "audio/transcriptions") {
    return await cf_transcribe(base, body, contentType, token)
  }
}

async function cf_chat(base, body, token) {
  const json = JSON.parse(body.toString())
  const model = "@cf/openai/gpt-oss-20b"
  const payload = {
    model,
    temperature: json.temperature,
    max_tokens: json.max_completion_tokens,
    messages: json.messages
  }
  if (json.reasoning_effort !== undefined) {
    payload.reasoning_effort = json.reasoning_effort
  }

  try {
    const r = await fetch(`${base}/ai/v1/chat/completions`, {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })

    // Bei 400 und wenn reasoning_effort gesendet wurde, nochmal ohne
    if (r.status === 400 && json.reasoning_effort !== undefined) {
      delete payload.reasoning_effort
      const r2 = await fetch(`${base}/ai/v1/chat/completions`, {
        method:"POST",
        headers:{
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })
      return { status: r2.status, text: await r2.text() }
    }

    return { status: r.status, text: await r.text() }
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: "network" })
  }
}

// Multipart byteweise zerlegen: das Audio darf nie als Text gelesen werden, sonst sind die Daten kaputt
function parseMultipart(buf, boundary) {
  const delim = Buffer.from("--" + boundary)
  const fields = {}
  let file = null
  let pos = buf.indexOf(delim)
  while (pos !== -1) {
    const start = pos + delim.length
    if (buf.slice(start, start + 2).toString() === "--") break // Schlussmarke
    const next = buf.indexOf(delim, start)
    if (next === -1) break
    const part = buf.slice(start + 2, next - 2) // Trennzeilen vorn und hinten abziehen
    const h = part.indexOf("\r\n\r\n")
    if (h !== -1) {
      const head = part.slice(0, h).toString("utf8")
      const content = part.slice(h + 4)
      const name = /name="([^"]+)"/.exec(head)
      if (name) {
        if (name[1] === "file") file = content
        else fields[name[1]] = content.toString("utf8")
      }
    }
    pos = next
  }
  return { fields, file }
}

async function cf_transcribe(base, body, contentType, token) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "")
  if (!m) return { status: 400, text: '{"error":{"message":"boundary fehlt"}}' }
  const { fields, file: fileBuffer } = parseMultipart(body, m[1] || m[2])
  const language = fields.language ? fields.language.trim() : null
  const prompt = fields.prompt ? fields.prompt.trim() : null
  if (!fileBuffer || !fileBuffer.length) return { status: 400, text: '{"error":{"message":"file fehlt"}}' }

  const audio = fileBuffer.toString("base64")

  const payload = {
    audio,
    language: language || undefined,
    initial_prompt: prompt ? prompt.substring(0, 600) : undefined
  }

  try {
    const r = await fetch(`${base}/ai/run/@cf/openai/whisper-large-v3-turbo`, {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })

    const text = await r.text()
    if (!r.ok) {
      return { status: r.status, text }
    }

    let result
    try {
      result = JSON.parse(text)
    } catch (e) {
      return { status: 502, text: JSON.stringify({ error: { message: "Cloudflare-Fehler" } }) }
    }

    if (!result.success || !result.result) {
      const status = result.success === false ? 502 : r.status
      const msg = (result.errors && result.errors[0] && result.errors[0].message) || "Cloudflare-Fehler"
      return { status, text: JSON.stringify({ error: { message: msg } }) }
    }

    // Sprache umwandeln
    const langMap = {
      en: "english", de: "german", it: "italian", es: "spanish", fr: "french",
      pt: "portuguese", nl: "dutch", pl: "polish", tr: "turkish", ru: "russian",
      uk: "ukrainian", ar: "arabic", he: "hebrew", fa: "persian", hi: "hindi",
      zh: "chinese", ja: "japanese", ko: "korean", vi: "vietnamese", th: "thai",
      id: "indonesian", sv: "swedish", no: "norwegian", da: "danish", fi: "finnish",
      cs: "czech", sk: "slovak", hu: "hungarian", ro: "romanian", bg: "bulgarian",
      el: "greek", sr: "serbian", hr: "croatian", ca: "catalan"
    }

    let lang = ""
    if (result.result.transcription_info && result.result.transcription_info.language) {
      const l = result.result.transcription_info.language
      if (l.length === 2 && langMap[l]) {
        lang = langMap[l]
      } else {
        lang = l.toLowerCase()
      }
    }

    // Ergebnis im Groq-Format
    const segments = result.result.segments || []
    return {
      status: 200,
      text: JSON.stringify({
        text: (result.result.text || "").trim(),
        language: lang,
        segments: segments.map(s => ({
          start: s.start,
          end: s.end,
          text: s.text,
          avg_logprob: s.avg_logprob
        }))
      })
    }
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: "network" })
  }
}
