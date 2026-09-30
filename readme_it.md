# fast-jev-compaction-opencode

Compattazione verbatim della sessione [opencode](https://opencode.ai) con un modello locale,
costruita su [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction).

Il progetto originale chiede a un modello probabilistico di valutare la conversazione e di decidere
quali tool call e tool result cancellare, invece di chiedere a un LLM di riassumere i turni vecchi.
I messaggi di testo non vengono mai riscritti, quindi un percorso di file, il testo esatto di un
errore o un vincolo sopravvivono alla compattazione.

Qui lo stesso motore è collegato ad opencode, con tre differenze:

| | originale (Claude Code) | qui (opencode) |
|---|---|---|
| trigger | hook `session.compact`, anche automatico a soglia di contesto | a richiesta: `/jev-compact` o il tool `jev_compact` |
| giudice | Jev in rete (TypeSafe, serve `TYPESAFE_API_KEY`) | qualsiasi endpoint OpenAI-compatibile, di default LM Studio |
| scrittura | Claude Code sostituisce la history | opencode: `session.revert` + reiniezione della coda |

La libreria viene usata come pubblicata: nessun fork, nessuna patch. tutto l'adattamento sta in un
file solo, `plugin/jev-compact.ts`.

## Come funziona

### Il passaggio del giudice

`fast-jev-compaction` costruisce uno stato dalla conversazione e gli pone delle domande:

1. ogni `tool_use` viene abbinato al suo `tool_result` tramite `tool_use_id`. Le call del primo
   messaggio e degli ultimi `preserveRecentMessages` sono pinned e non vengono toccate;
2. lo stato è la conversazione completa, dal più vecchio, con ogni tool result sostituito da una nota
   (`ok, 4213 chars (omitted)`). Input dei tool e testi ci sono per intero;
3. se lo stato supera `maxStateTokens` (25k di default) viene ridotto a stadi, ognuno applicato solo
   se il precedente non basta: input troncati a 1000, poi 200, poi 60 caratteri; testi lunghi
   abbreviati in testa e coda; messaggi vecchi non pinned ridotti a `[… N chars omitted …]`; call
   vecchie ridotte a una riga (`t12 Read file_path=src/a.ts → ok 480ch`). Se non basta comunque,
   la compattazione lancia un errore. I token sono stimati sui caratteri, non c'è un tokenizer;
4. ogni call non pinned riceve due domande probabilistiche: `call_tN` (sapere che la call è stata
   fatta, col suo input, conta ancora) e `result_tN` (i contenuti del risultato servono ancora,
   dato che rieseguire il tool non li riprodurrebbe);
5. le domande vengono spezzate in più richieste perché stato più domande stiano sotto
   `maxRequestTokens` (30k, giusto sotto i 32k di contesto del giudice). Lo stato completo è
   rispedito a ogni richiesta, le richieste girano in parallelo, le risposte vengono unite;
6. ogni risposta viene confrontata con `keepThreshold` (0.5): il risultato sopra soglia tiene call e
   result; altrimenti la call sopra soglia tiene la call e tronca il result ai primi
   `truncateHeadChars` (300) caratteri più una nota; altrimenti vengono rimossi entrambi;
7. la lista messaggi viene ricostruita. I messaggi che perdono tutto il contenuto spariscono, e
   quelli non toccati tornano come **stessi oggetti**: è questo che permette a chi chiama di capire
   cosa è cambiato.

Errori del giudice, risposte malformate, chiave assente o storia non riducibile fanno eccezione. Il
fallback lo decide il chiamante: l'originale ricade sul riassunto di Claude Code, qui non viene
cambiato nulla.

### Come il risultato torna in una sessione opencode

opencode non ha un endpoint per sostituire messaggi già salvati. Le API sessione danno la lettura
(`session.messages`), l'invio di un prompt (`session.prompt`, con `noReply: true` per iniettare
contesto senza far rispondere il modello) e `session.revert`, che riporta la sessione a un messaggio
e scarta tutto quello che segue. Non esiste un delete o un upsert di messaggi, né nella 1.18.30 né
nell'SDK pubblico.

Quindi la lista potata non può semplicemente sostituire la history. L'unica cosa disponibile è
troncare in un punto e riscrivere ciò che viene dopo. Il plugin fa così:

* i messaggi non toccati tornano dalla libreria come gli stessi oggetti, quindi `indexOf` sull'array
  originals dà gratis l'insieme degli indici sopravvissuti;
* `dropped` è il complemento. Se è vuoto non c'è nulla da fare;
* `cut = max(dropped) + 1`, cioè l'ultimo messaggio modificato;
* `session.revert(all[cut].info.id)` scarta quel messaggio e tutto quello che segue. Tutto ciò che
  viene prima resta nel database con role, tool part e timestamp intatti;
* la coda (messaggi sopravvissuti con indice originale `>= cut`) viene re-iniettata con
  `session.prompt({ noReply: true })`, un messaggio per ogni run di messaggi consecutivi dello stesso
  ruolo, ognuno marcato `<!-- jev-compact:user -->` o `<!-- jev-compact:assistant -->`.

Tagliare all'ultimo messaggio modificato invece che al primo è ciò che tiene piccolo il danno. Una
prima versione tagliava al primo messaggio non pinned e re-iniettava tutto il seguito, il che
appiattiva la struttura di ogni messaggio successivo, compresi quelli che il giudice non aveva
toccato. Con il taglio attuale il prefisso non toccato resta un messaggio vero, e le call rimosse
sono quasi sempre nella parte vecchia della history.

Quello che si perde: la coda re-iniettata è testo semplice. Le tool part tornano come
`[tool X] {"input"}` più il loro output. Il contenuto è integro, la struttura no. Per sistemarlo
servirebbe un upsert di messaggi nell'SDK opencode, che non esiste.

### Il giudice locale

La libreria non sa nulla di opencode né di LM Studio. Parla il protocollo Jev attraverso una sola
interfaccia:

```ts
interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
```

Lo stato è la conversazione ridotta, le domande sono le `noul` da rispondere, la risposta è
`{ answers: { call_t1: { noul: 0.93 }, result_t1: { noul: 0.10 } } }`, una probabilità tra 0 e 1 per
domanda. `JevClient` è una implementazione di quell'interfaccia e parla con TypeSafe. Quella in
questo repo è un'altra implementazione, OpenAI-compatibile:

* `POST http://127.0.0.1:1234/v1/chat/completions` (LM Studio, carica `LM Studio API` da
  Developer → API Usage), modello `rizzo-flow` di default;
* il system prompt chiede un oggetto JSON che mappa ogni nome di domanda alla probabilità che
  l'affermazione sia vera, con `temperature: 0`;
* il JSON grezzo viene estratto con una regex `\{[\s\S]*\}` e mappato a `{ noul: Number(p) }`.

Poiché il contratto è "un numero per domanda", l'algoritmo di `compact()` e la logica delle soglie
sono quelli upstream, non modificati. È il motivo per cui tutto l'adapter sta in circa 140 righe
invece che in un fork.

Nessuna API key, nessuna chiamata di rete. Endpoint e modello si cambiano con `JEV_LMSTUDIO_URL` e
`JEV_LMSTUDIO_MODEL`.

### Perché a richiesta

opencode compatta già da solo (`compaction.auto`, `compaction.tail_turns`). Il punto qui è scegliere
per sessione: usare il `/compact` di opencode quando un riassunto va bene, usare `/jev-compact` quando
la fedeltà letterale conta. Per questo il plugin non tocca `compaction` e non si aggancia a
`experimental.session.compacting`: registra un tool e un comando e non fa nulla finché non viene
chiamato. Riscrivere la history, poi, non è una cosa da far girare senza supervisione.

## Installazione

Requisiti: opencode 1.18 o successivo, Node 18+, un endpoint OpenAI-compatibile (LM Studio, Ollama,
vLLM, llama.cpp, …).

### Copia i file

```sh
# globale, consigliato
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/command
cp plugin/jev-compact.ts   ~/.config/opencode/plugin/
cp command/jev-compact.md  ~/.config/opencode/command/

# oppure per progetto
mkdir -p .opencode/plugin .opencode/command
cp plugin/jev-compact.ts   .opencode/plugin/
cp command/jev-compact.md  .opencode/command/
```

opencode carica da solo ogni `*.ts` in `plugin/` o `plugins/`, non serve nessuna entry in
`opencode.json`.

### Installa la dipendenza

opencode lancia `bun install` all'avvio usando il `package.json` della directory di config. Senza quel
file l'import non risolve.

```sh
cd ~/.config/opencode                # o la root del progetto
npm pkg set dependencies.fast-jev-compaction="^0.4.1"
npm pkg set dependencies.@opencode-ai/plugin="^1.14.38"
npm install
```

### Collegalo al tuo modello

I default vanno bene con LM Studio. Per altro backend:

```sh
export JEV_LMSTUDIO_URL="http://127.0.0.1:1234/v1/chat/completions"
export JEV_LMSTUDIO_MODEL="qwen2.5-14b-instruct"
```

Oppure modifica le due costanti in cima a `plugin/jev-compact.ts`.

### Riavvia e usa

opencode non ricarica i plugin, quindi chiudi e riapri.

```
/jev-compact                    # preserveRecentMessages 0, minReduction 0.25
/jev-compact 4                  # blocca gli ultimi 4 messaggi
```

Oppure chiedi all'agente di usare il tool `jev_compact`. Il tool stampa messaggi e caratteri
prima/dopo, riduzione percentuale, call tenute/troncate/rimosse, numero di richieste, ms e quanti
messaggi sono stati re-iniettati come testo.

Se qualcosa va storto dopo il revert: `client.session.unrevert({ path: { id: sessionID } })`.

## Opzioni

| Argomento del tool | default | significato |
|---|---|---|
| `preserveRecentMessages` | `0` | gli ultimi N messaggi sono pinned, mai toccati |
| `minReduction` | `0.25` | sotto questa riduzione non viene cambiato nulla |

Ereditati dalla libreria (`CompactOptions`), modificabili nella chiamata a `compact()`: `goal`
(default: ultimi 3 prompt utente), `keepThreshold` (0.5), `maxStateTokens` (25k),
`maxRequestTokens` (30k), `truncateHeadChars` (300).

## Che cosa cambia rispetto all'originale

`src/` di `fast-jev-compaction` è intatto. L'adapter usa solo export pubblici: `compact`,
`reductionRatio` e i tipi `JevAsker`, `JevState`, `JevQuestions`, `Message`.

Rispetto a `hooks/fast-jev.ts`, l'adapter per Claude Code:

1. nessun hook `session.compact`, solo tool e comando;
2. `JevClient` sostituito dal `JevAsker` locale OpenAI-compatibile, quindi `compactMessages` e
   `TYPESAFE_API_KEY` non vengono usati;
3. conversione del transcript da `client.session.messages()`: ogni `ToolPart` di opencode contiene
   già sia la call (`state.input`) sia il result (`state.output` o `state.error.output`), quindi
   diventa un `ToolUse` con `tool_use_id = part.callID` e senza `toolResult` separati;
4. scrittura tramite `session.revert` più `session.prompt({ noReply: true })` sulla coda;
5. l'identità dei messaggi del punto 7 del giudice serve a calcolare `dropped` e `cut`;
6. i fallback sono i casi "non cambiare nulla" invece del riassunto nativo: history più corta di 4
   messaggi, giudice che fallisce, riduzione sotto soglia, nessuna call rimossa, guadagno limitato
   alla sola coda.

## Limiti noti

* la coda re-iniettata è testo, le tool part non sopravvivono alla riscrittura;
* non viene mandato nessuno JSON schema al modello, quindi una risposta non JSON fa fallire la
  compattazione (e non cambia nulla). `response_format: { type: "json_schema" }` lo risolverebbe;
* un modello locale è più debole di Jev nel giudizio probabilistico. Alza `keepThreshold` se è
  troppo permissivo, abbassalo se è troppo cauto;
* i token sono stime sui caratteri, ereditate dall'originale: `maxStateTokens` non è esatto;
* il revert scarta messaggi, e con loro qualunque cosa li referenziasse per id.

## Licenza

Codice dell'adapter: MIT, come il progetto originale ([`LICENSE`](./LICENSE), © tamaratran).
`fast-jev-compaction` resta una dipendenza npm con la sua licenza.
