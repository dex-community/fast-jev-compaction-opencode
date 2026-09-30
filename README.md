# fast-jev-compaction-opencode

Compattazione **verbatim** della sessione [opencode](https://opencode.ai) con un modello locale,
costruita sopra [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction).

Il progetto originale è un plugin **Claude Code** + libreria npm che sostituisce il riassunto di
compattazione con le decisioni di un modello probabilistico ("Jev", di TypeSafe): ogni tool call e
ogni tool result viene valutato, quelli non più utili vengono **rimossi o troncati**, e tutto il
resto resta **letterale**. Niente riassunti, niente perdita di path, errori esatti, vincoli.

Qui lo stesso motore viene adattato ad **opencode**, con tre differenze rispetto all'originale:

| | originale (Claude Code) | qui (opencode) |
|---|---|---|
| Trigger | hook `session.compact` / auto a soglia di contesto | **on demand**: comando `/jev-compact` o tool `jev_compact` |
| Modello | Jev remoto (TypeSafe, serve `TYPESAFE_API_KEY`) | **qualsiasi endpoint OpenAI-compatibile**, di default LM Studio in locale |
| Scrittura in DB | l'host Claude Code sostituisce la history | opencode: `session.revert` + reiniezione della coda |

---

## 1. Come funziona (teoria)

### 1.1 Il problema

La compattazione classica di un agente LLM chiede a un altro LLM di riassumere i turni vecchi.
Un riassunto è **lossy**: un percorso di file, il testo esatto di un errore, un vincolo, un comando
utile possono sparire e il modello continua a lavorare su informazioni che non ha più.
`fast-jev-compaction` non riscrive mai nulla: **cancella solo i tool call e i tool result che il
giudice considera inutili**, e lascia intatti i messaggi di testo, in ordine.

### 1.2 L'algoritmo (dalla libreria, non modificato)

1. **Pairing.** Ogni `tool_use` viene abbinato al suo `tool_result` tramite `tool_use_id`.
   I call del primo messaggio e quelli degli ultimi `preserveRecentMessages` messaggi sono
   **pinned** e non vengono mai toccati.
2. **Stato inviato al giudice.** Non un riassunto: **l'intera conversazione** in ordine cronologico,
   con i tool *result* sostituiti da una nota (`ok, 4213 chars (omitted)`). Input dei tool e testi
   sono inclusi per intero. Niente è riassunto.
3. **Riduzione del budget** (`maxStateTokens`, 25k di default) a stadi, applicati solo se il
   precedente non basta: input dei tool troncati a 1000 → 200 → 60 caratteri; testi lunghi
   abbreviati in testa+ coda; messaggi vecchi non pinned prima collassati; call ridotti a una riga
   (`t12 Read file_path=src/a.ts → ok 480ch`); ecc. Se non basta comunque, la compattazione **lancia
   un errore** invece di degradare la qualità. I token sono stimati a caratteri, non con un
   tokenizer.
4. **Domande.** Per ogni call non pinned due domande di probabilità:
   * `call_tN`: la **chiamata** deve restare (sapere che è stata fatta, con il suo input, conta)?
   * `result_tN`: il **resultato** deve restare verbatim (i suoi contenuti servono e non si può
     rieseguire il tool)?
5. **Batching.** Le domande sono spezzate in più richieste perché stato+domande restino sotto
   `maxRequestTokens` (30k, sotto il limite di 32k del modello). Lo stato completo è rispedito a
   ogni richiesta; le richieste girano in parallelo e le risposte vengono unite.
6. **Decisione** contro `keepThreshold` (0.5):
   * `result ≥ soglia` → restano chiamata **e** risultato;
   * altrimenti `call ≥ soglia` → resta la **chiamata**, il risultato viene troncato ai primi
     `truncateHeadChars` (300) caratteri più una nota;
   * altrimenti → chiamata **e** risultato rimossi.
7. **Ricostruzione.** Un messaggio che perde tutto il contenuto sparisce, i messaggi non toccati
   vengono restituiti come **stessi oggetti** (identità preservata: questo dettaglio è ciò che
   permette a chi chiama di capire cosa è cambiato), e un resultato non resta mai senza la sua call.

Errori del giudice, risposte malformate, chiave assente o storia non riducibile → **throw**: decide
il chiamante (nel plugin Claude Code originale: fallback al riassunto nativo; qui: nessuna
modifica).

### 1.3 Cosa cambia per opencode (la parte non banale)

**Teoria del vincolo.** opencode non espone alcun endpoint per *sostituire singoli messaggi* già
persistiti. Le API sessione disponibili sono: leggere messaggi (`session.messages`), inviare un prompt
(`session.prompt`, con `noReply: true` per iniettare contesto senza risposta), e **`session.revert`**
(riporta la sessione a un messaggio preciso, scartando tutto ciò che segue, reversibile con
`session.unrevert`). Non esiste delete/upsert di messaggi né nella 1.18.30 né nella API pubblica.

**Conseguenza.** Non si può "sostituire la history con la lista potata". Si può solo **troncare a un
punto** e **riscrivere ciò che viene dopo**. Da qui la strategia:

* la libreria restituisce i messaggi intatti come **stessi oggetti** → con `indexOf` nel vettore
  originale si ricava esattamente **quali indici sono sopravvissuti**;
* `dropped` = indici spariti; se è vuoto non c'è nulla da fare;
* `cut = max(dropped) + 1` → **l'ultimo messaggio modificato**;
* `session.revert(messageID = all[cut])` scarta da lì in poi: tutto il **prefisso non toccato resta
  intatto nel DB** con role, tool-part, timestamp, cache;
* la **coda** (`result.messages` con indice originale ≥ `cut`) viene re-iniettata con
  `session.prompt({ noReply: true })`, **un messaggio per run di ruolo** consecutivi, con un marker
  `<!-- jev-compact:user -->` / `<!-- jev-compact:assistant -->`.

**Perché tagliare all'ultimo e non al primo messaggio modificato.** Una prima versione tagliava al
primo messaggio non pinned e re-iniettava *tutto* il seguito: distruggeva la struttura di ogni
messaggio successivo, anche di quelli che il giudice non aveva toccato. Tagliando all'ultimo, il
danno è limitato alla coda realmente alterata: più messaggi reali sopravvivono intatti, e il
contesto si riduce comunque (i tool call rimossi sono quasi sempre sparsi nelle zone vecchie).

**Limite residuo dichiarato.** La coda re-iniettata è **testo**: i `tool-part` diventano
`[tool X] {json input}\noutput`. Il contenuto è integro, la struttura no. Rimuovere il limite
richiede un endpoint `message upsert` nell'SDK opencode (non esiste). È annotato con un commento
`ponytail:` nel codice con la via di upgrade.

**Nessuna modifica distruttiva a caso.** Quattro guardie, tutte "nessuna modifica": storico con meno
di 4 messaggi; giudice che lancia; riduzione sotto `minReduction` (0.25 di default, il parametro
`minReductionRatio` del plugin originale); nessuna call rimossa; guadagno limitato alla sola coda.
`session.unrevert` esiste come rete di sicurezza se qualcosa va storto dopo il revert.

### 1.4 Il giudice locale (LM Studio)

La libreria non sa nulla di opencode e di LM Studio: parla il **protocollo Jev** e accetta un
`JevAsker`, un'interfaccia con un solo metodo:

```ts
interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
```

`state` è la conversazione compressa (context, goal, history), `questions` sono le `noul` da
rispondere, la risposta è `{ answers: { call_t1: { noul: 0.93 }, result_t1: { noul: 0.10 } } }` —
una probabilità 0..1 per domanda. Il client ufficiale (`JevClient`) è un `JevAsker` che parla con
TypeSafe; **qui l'implementazione è un altro `JevAsker`** che parla OpenAI-compatibile:

* `POST http://127.0.0.1:1234/v1/chat/completions` (LM Studio, carica `LM Studio API` in
  Developer → API Usage), modello `rizzo-flow` di default;
* system prompt: "rispondi con un JSON che mappa ogni nome di domanda alla probabilità 0..1 che
  l'affermazione sia vera", `temperature: 0`;
* il JSON grezzo viene parsato con una regex `\{[\s\S]*\}` e mappato in `{ noul: Number(p) }`.

Nessuna `TYPESAFE_API_KEY`, nessuna rete. L'unico contratto mantenuto è "un numero 0..1 per domanda",
quindi l'algoritmo di `compact()` è **identico** a quello originale: è questo il motivo per cui
l'adattamento è ~140 righe invece di un fork della libreria.

**Limite dichiarato.** Nessuna validazione strutturata della risposta (niente `json_schema` /
tool calling): se il modello sbaglia il formato, la regex non trova nulla e l'errore viene
propagato come "compattazione fallita, nessuna modifica". Un `response_format: json_schema` in
LM Studio lo eliminerebbe, se serve.

### 1.5 Perché on demand e non automatico

opencode ha già la sua compattazione automatica (`compaction.auto`, `compaction.tail_turns`).
L'utente di questo progetto vuole **scegliere** quale usare a ogni sessione: il comando standard
(opcode) quando conviene un riassunto, `/jev-compact` quando la fedeltà letterale conta. Il plugin
quindi **non tocca `compaction` e non si aggancia a `experimental.session.compacting`**: espone solo
un tool e un comando, e non fa nulla finché non viene invocato. In più l'operazione è distruttiva
(revert + reiniezione): renderla automatica senza supervisione sarebbe una scelta discussa.

---

## 2. Installazione (tutorial)

Prerequisiti: opencode ≥ 1.18, Node ≥ 18, un endpoint OpenAI-compatibile (LM Studio, Ollama,
vLLM, llama.cpp…).

### 2.1 Copia i file

```sh
# globale (consigliato)
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/command
cp plugin/jev-compact.ts        ~/.config/opencode/plugin/
cp command/jev-compact.md       ~/.config/opencode/command/

# oppure solo in un progetto
mkdir -p .opencode/plugin .opencode/command
cp plugin/jev-compact.ts        .opencode/plugin/
cp command/jev-compact.md       .opencode/command/
```

opencode carica automaticamente ogni `*.ts` in `plugin/`/`plugins/`, senza entry in `opencode.json`.

### 2.2 Installa la dipendenza

opencode esegue `bun install` all'avvio usando il `package.json` della directory di config: senza
quel file le dipendenze non risolvono.

```sh
cd ~/.config/opencode            # o la root del progetto
npm pkg set dependencies.fast-jev-compaction="^0.4.1"
npm pkg set dependencies.@opencode-ai/plugin="^1.14.38"
npm install
```

### 2.3 Configura endpoint e modello

Default già pronti: `http://127.0.0.1:1234/v1/chat/completions` e `rizzo-flow`. Per altro backend:

```sh
export JEV_LMSTUDIO_URL="http://127.0.0.1:1234/v1/chat/completions"
export JEV_LMSTUDIO_MODEL="qwen2.5-14b-instruct"
```

In alternativa, senza env: cambia le due costanti in cima a `plugin/jev-compact.ts`.

### 2.4 Riavvia e usa

opencode non hot-relaodа i plugin: **chiudi e riapri opencode**.

```
/jev-compact                      # defaults: preserveRecentMessages 0, minReduction 0.25
/jev-compact 4                    # conserva intatti gli ultimi 4 messaggi
```

Oppure chiedi all'agente: "usa il tool jev_compact". L'output del tool riporta messaggi e caratteri
prima/dopo, riduzione percentuale, call tenute/troncate/rimosse, richieste, ms e quanti messaggi
sono stati re-iniettati come testo.

Rete di sicurezza se qualcosa va storto dopo il revert:
`client.session.unrevert({ path: { id: sessionID } })`.

---

## 3. Parametri

| Tool arg | Default | Significato |
|---|---|---|
| `preserveRecentMessages` | `0` | ultimi N messaggi pinned, mai toccati |
| `minReduction` | `0.25` | sotto questa riduzione non si tocca niente |

Ereditati dalla libreria (`CompactOptions`), modificabili in `compact()`:
`goal` (default: ultimi 3 prompt utente), `keepThreshold` (0.5), `maxStateTokens` (25k),
`maxRequestTokens` (30k), `truncateHeadChars` (300).

---

## 4. Cosa è stato scritto qui (vs. l'originale)

Libreria `src/` di `fast-jev-compaction`: **invariata**. Nessun fork, nessun patch.
Tutto il codice di adattamento è in `plugin/jev-compact.ts` (~140 righe) e sfrutta gli export
pubblici: `compact`, `reductionRatio` e i tipi `JevAsker`, `JevState`, `JevQuestions`, `Message`.

Punti di divergenza rispetto a `hooks/fast-jev.ts` (l'adapter per Claude Code):

1. **Nessun hook `session.compact`**: tool + comando, esecuzione manuale.
2. **`JevClient` → `lmstudio`**: `JevAsker` OpenAI-compatibile locale, niente API key.
   In originale: `compactMessages(transcript, { apiKey, model, ... })`.
3. **Transcript**: `client.session.messages()` → `Message[]`. Ogni `ToolPart` di opencode contiene
   già sia la chiamata (`state.input`) sia il risultato (`state.output` / `state.error.output`),
   quindi un `ToolUse` per part, con `tool_use_id = part.callID`. I `toolResult` non servono: il
   pairing è implicito nella stessa parte.
4. **Scrittura**: `session.revert(all[cut])` + `session.prompt({ noReply: true })` sulla coda
   (l'originale si limita a restituire i messaggi all'host).
5. **Identità dei messaggi** sfruttata per calcolare `dropped` e `cut`.
6. **Guardie di non-distruzione** (soglia di riduzione, storico corto, nessuna call rimossa,
   guadagno solo in coda) al posto del fallback al riassunto nativo.

---

## 5. Limiti noti

* **La coda re-iniettata è testo**: nessun `tool-part` nella parte ri-iniettata. Contenuto
  integro, struttura no. Fix: endpoint message upsert in SDK opencode.
* **Nessun JSON schema** sulla chiamata al modello: una risposta non-JSON fa fallire la
  compattazione (senza modifiche). Fix: `response_format: { type: "json_schema" }` su LM Studio.
* **Il giudice locale è più debole di Jev** su un task probabilistico: alza `keepThreshold` se il
  modello locale è troppo permissivo (o abbassalo se è troppo cauto, al costo di più perdita).
* **Stima token a caratteri** (ereditata): `maxStateTokens` non è un conteggio esatto.
* **Il revert invalida eventuali riferimenti a messaggi successivi** (niente in questa sessione li
  usa).
* La compattazione automatica di opencode resta attiva e **non** è governata da questo plugin.

## 6. Licenza

Codice di adattamento: MIT, come il progetto originale ([`LICENSE`](./LICENSE), © tamaratran).
`fast-jev-compaction` resta un pacchetto npm con licenza propria, installato come dipendenza.
