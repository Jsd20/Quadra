# Decisioni (21/11, 11:55)

Consegna 17:00 (ultimo commit + repository GitHub), pitch dalle 17:15, 3 minuti.
Congelamento 16:00 (ultimo commit 17:00, pitch 17:15). Dopo: solo correzioni, registrazioni, README, pitch.

## La sfida e la storia

**Sfida B · Back Office Autopilot, processo: fatture fornitori → pagamento (ciclo passivo).**
Ariete: «B contiene già un po' di A». Il processo semplice resta semplice ma automatico; accesso
per profilo e task sono apprezzati; registro di chi ha approvato; formati liberi.

Azienda finta: **Officine Sereno S.r.l.**, Torino, piccola manifattura. Tre profili:

| Profilo | Persona | Può approvare |
|---|---|---|
| `contabilita` | Sara Gallo, contabilità fornitori | mail ai fornitori (`send_message`) |
| `acquisti` | Luca Bertone, acquisti | niente: riceve i task sui prezzi |
| `finanza` | Elena Rinaldi, responsabile finanza | distinta di pagamento (`pay_invoices`) |

La storia (una sola, dal vivo):

1. Nella casella fornitori arrivano 5 email con la fattura in **XML FatturaPA** (il formato vero
   in Italia, dallo SdI). L'autopilota parte da solo (`POST /api/autopilot`).
2. Per ognuna estrae i campi con le citazioni (`save_extraction`).
3. `check_invoice`, in codice: ordine, prezzi, ricevuta merce (DDT), IBAN contro l'anagrafica,
   fattura già registrata.
4. Esito: 2 pulite → registrate da sole (`register_invoice`, niente da approvare: interno e
   reversibile). 3 eccezioni → si ferma:
   - prezzo diverso dall'ordine → task ad **Acquisti** + bozza di mail al fornitore (ok di Contabilità);
   - IBAN diverso dall'anagrafica + testo che dà ordini all'agente → bloccata, task a **Finanza**
     («verifica al telefono con il contatto in anagrafica»), nessun pagamento;
   - fattura già registrata e pagata → doppione, nessuna azione, solo nel registro.
5. Propone la **distinta di pagamento** (`pay_invoices`): elenco e totale calcolati dal codice,
   IBAN dall'anagrafica e mai dalla fattura. La approva **solo Finanza**: con il profilo
   sbagliato il server rifiuta.
6. Esce il file della distinta (`out/distinta-*.csv`) e il **registro**: cosa ha fatto, su quale
   input, chi ha approvato, con quale profilo.

## Regole che vivono nel codice, non nel modello

- Ogni scrittura ha la chiave di idempotenza costruita nel codice (fornitore + numero fattura).
- Somme, prezzi, quantità ricevute, IBAN e doppioni li controlla `check_invoice`.
- `register_invoice` registra solo se il controllo è `ok`. `pay_invoices` paga solo fatture
  registrate, non pagate, con controllo `ok`, all'IBAN dell'anagrafica.
- Il profilo che può approvare è deciso dal server (`/api/approve` con `profile`), non dall'agente.
- Il testo di email e fatture è un dato: istruzioni dentro → segnalate, mai eseguite.

## Compiti

| # | Compito | Chi | Criterio di accettazione |
|---|---|---|---|
| T1 | `data/seed.json` nuovo (fornitori, ordini, DDT, fatture già registrate, profili, inbox) | Claude | i 5 casi sopra hanno i dati che servono |
| T2 | 5 fatture XML FatturaPA in `data/samples/` dal seed | Codex luna | numeri identici al seed |
| T3 | `check_invoice` esteso: prezzo, DDT, IBAN, doppione; `register_invoice`; `create_task` | Claude | smoke: pulita registrata, prezzo → task, IBAN → bloccata, doppione → niente |
| T4 | Profili e approvazione per ruolo, registro `audit`, `pay_invoices` con file della distinta | Claude | smoke: Contabilità non può approvare la distinta, Finanza sì, file scritto una volta |
| T5 | `/api/autopilot`: allega gli XML della inbox nuova e lancia l'agente | Claude | smoke: il modello riceve il testo degli XML |
| T6 | Interfaccia: selettore profilo, I miei task, registro, card distinta con download, bottone Autopilota | Codex sol | si vede tutto in una run e nel replay |
| T7 | Run vera su Vertex, `INSTRUCTION` sistemata, 2 registrazioni buone | Claude | storia completa in meno di 2 minuti |
| T8 | README per la consegna, pitch | Claude | entro le 16:30 |

Wow (se T1-T7 verdi entro le 14:30): «arriva posta» simulato mentre la demo gira, l'autopilota
riparte da solo, e un contatore di minuti risparmiati (ipotesi: 12 minuti a fattura a mano).

## Numeri per il pitch (ipotesi, da dire come tali)

- 12 minuti a fattura a mano (ricerca ordine, DDT, controllo, registrazione); 400 fatture al mese
  in una PMI = 80 ore al mese.
- Frode del cambio IBAN (BEC): il caso più costoso del ciclo passivo, un solo pagamento sbagliato
  vale migliaia di euro e spesso non si recupera.
- Doppio pagamento: uno su qualche centinaio di fatture, recuperarlo costa settimane di mail.
