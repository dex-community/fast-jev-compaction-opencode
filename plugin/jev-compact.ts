import { tool, type Plugin } from "@opencode-ai/plugin"
import { compact, reductionRatio, type JevAsker, type JevState, type JevQuestions, type Message } from "fast-jev-compaction"

const LMSTUDIO_URL = process.env.JEV_LMSTUDIO_URL ?? "http://127.0.0.1:1234/v1/chat/completions"
const LMSTUDIO_MODEL = process.env.JEV_LMSTUDIO_MODEL ?? "rizzo-flow"

// ponytail: la libreria parla il protocollo Jev (noul = 0..1). Qui lo traduciamo
// in una chiamata OpenAI-compatibile a LM Studio che restituisce le stesse
// probabilità. Limite: nessuna validazione strutturata, si parsla il JSON grezzo.
const lmstudio: JevAsker = {
  async ask(state: JevState, questions: JevQuestions) {
    const keys = Object.keys(questions)
    const res = await fetch(LMSTUDIO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You prune agent histories. For each question answer a probability between 0 and 1 that the statement is TRUE " +
              "given the conversation state. Reply with JSON only: an object mapping each question name to its probability.",
          },
          { role: "user", content: JSON.stringify({ state, questions }) },
        ],
      }),
    })
    if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as any
    const text: string = body?.choices?.[0]?.message?.content ?? ""
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error("LM Studio non ha risposto con JSON")
    const probs = JSON.parse(m[0])
    return { answers: Object.fromEntries(keys.map((k) => [k, { type: "noul", noul: Number(probs[k]) }])) }
  },
}

// ponytail: opencode non ha endpoint per sostituire singoli messaggi, solo
// session.revert. Quindi tagliamo all'ULTIMO messaggio modificato: tutto il
// prefisso identico resta intatto nel DB e si re-inietta solo il coda alterata,
// ricalcata da result.messages. Limite residuo: la coda re-iniettata è testo
// (niente tool-part). Upgrade: endpoint message upsert in SDK.
function toJev(messages: { info: any; parts: any[] }[]): Message[] {
  return messages.map((m) => {
      const text: string[] = []
      const toolUses: Message["toolUses"] = []
      for (const p of m.parts) {
        if (p.type === "text" && p.text) text.push(p.text)
        else if (p.type === "tool") {
          const out = p.state?.output ?? p.state?.error?.output ?? ""
          toolUses.push({
            tool_use_id: p.callID,
            tool: p.tool,
            input: p.state?.input ?? {},
            text: typeof out === "string" ? out : JSON.stringify(out),
            isError: p.state?.status === "error",
          })
        }
      }
      return { role: m.info.role === "assistant" ? "assistant" : "user", text: text.join("\n\n"), toolUses, toolResults: [] }
    })
}

function render(msgs: Message[]): string {
  const out: string[] = []
  for (const m of msgs) {
    if (m.text) out.push(m.text)
    for (const t of m.toolUses) {
      out.push(`\n[tool ${t.tool}] ${JSON.stringify(t.input)}\n${t.isError ? "ERROR: " : ""}${t.text ?? ""}`)
    }
  }
  return out.join("\n\n")
}

export const JevCompact: Plugin = async ({ client }) => ({
  tool: {
    jev_compact: tool({
      description:
        "Compact the current session history with Jev (TypeSafe): drops or truncates tool calls Jev says are no longer needed, keeps everything else verbatim. Destructive: reverts the session at the last modified message and re-injects only the altered tail. Use only when the user explicitly asks.",
      args: {
        preserveRecentMessages: tool.schema.number().optional(),
        minReduction: tool.schema.number().optional(),
      },
      async execute(args, ctx) {
        const sessionID = ctx.sessionID
        const preserve = args.preserveRecentMessages ?? 0
        const minReduction = args.minReduction ?? 0.25
        const { data } = await client.session.messages({ path: { id: sessionID } })
        const all = data as { info: any; parts: any[] }[]
        const msgs = toJev(all)
        if (msgs.length < 4) return "Storico troppo corto, niente da compattare."

        let result
        try {
          result = await compact(msgs, lmstudio, { preserveRecentMessages: preserve })
        } catch (e) {
          return `Compattazione fallita, nessuna modifica: ${(e as Error).message}`
        }
        const ratio = reductionRatio(result)
        const s = result.stats
        if (ratio < minReduction) return `Riduzione ${(ratio * 100) | 0}% sotto il minimo: nessuna modifica.`

        // ultimi indice originale sopravvissuto: i messaggi non toccati restano nel DB
        const keptIdx: number[] = []
        for (const m of result.messages) {
          const at = msgs.indexOf(m)
          if (at < 0) continue
          keptIdx.push(at)
        }
        const dropped = msgs.map((_, i) => i).filter((i) => !keptIdx.includes(i))
        if (!dropped.length) return "Nessun tool call da rimuovere: nessuna modifica."
        const cut = Math.max(...dropped) + 1
        const tail = result.messages.filter((m) => keptIdx.indexOf(msgs.indexOf(m)) >= cut)
        if (!tail.length) return "Solo la coda era rimovibile: guadagno nullo, nessuna modifica."

        await client.session.revert({ path: { id: sessionID }, body: { messageID: all[cut].info.id } })
        // un messaggio per run di ruolo, così assistant/user alternano come nella history reale
        const runs: { role: string; body: string }[] = []
        for (const m of tail) {
          const body = render([m])
          const last = runs[runs.length - 1]
          if (last && last.role === m.role) last.body += `\n\n${body}`
          else runs.push({ role: m.role, body })
        }
        for (const r of runs) {
          await client.session.prompt({
            path: { id: sessionID },
            body: { noReply: true, parts: [{ type: "text", text: `<!-- jev-compact:${r.role} -->\n${r.body}` }] },
          })
        }
        return (
          `Compattato: ${s.messagesBefore}→${s.messagesAfter} messaggi, ${s.charsBefore}→${s.charsAfter} chars, ` +
          `riduzione ${(ratio * 100) | 0}%, ${s.calls} tool call (tenuti ${s.kept}, risultati troncati ${s.resultsDropped}, rimossi ${s.callsDropped}), ` +
          `${s.requests} richieste, ${s.ms}ms, ${all.length - cut} messaggi re-iniettati come testo`
        )
      },
    }),
  },
})
