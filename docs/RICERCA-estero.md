# Fatture dei fornitori esteri: il processo e dove si perdono tempo e soldi

Ricerca del 21/11/2026, dopo il confronto con Ariete: le fatture italiane arrivano già in XML dallo
SdI e sono il problema risolto. Quelle estere no.

## Il processo oggi

1. La fattura arriva per **email in PDF**, a volte a una persona invece che alla casella fornitori.
   È fuori dallo SdI e dal cassetto fiscale: il commercialista e il gestionale non la vedono.
2. Qualcuno deve capire **a quale ordine e a quale bolla corrisponde**. Il numero d'ordine spesso
   manca o è scritto a modo loro, la lingua è un'altra, le righe sono descritte diversamente.
3. Si controlla la **partita IVA sul VIES** e si conserva la prova datata. Una fattura UE senza IVA
   non è "esente": è in reverse charge, e va integrata.
4. Il cliente italiano manda allo SdI un **documento di integrazione**:
   - **TD18**: beni da fornitore UE;
   - **TD17**: servizi da fornitore UE o extra-UE;
   - **TD19**: beni già in Italia da fornitore estero.
   - Beni extra-UE: niente integrazione, vale la **bolletta doganale**, da abbinare alla fattura
     del fornitore e a quella dello spedizioniere.
5. Scadenza: entro il **15 del mese dopo** la ricezione (UE) o l'operazione (extra-UE). La prova
   della data di ricezione è la mail, da conservare con il PDF.
6. Cambio: quello del giorno dell'operazione (art. 13 DPR 633/72).

L'esterometro non esiste più dal 1/7/2022 (DL 146/2021, circ. 26/E/2022): ogni fattura estera è un
invio a sé, con la sua scadenza.

## I pain point, con i numeri

| Dove si perde | Quanto | Fonte |
|---|---|---|
| Inserimento a mano | 5-7 min per una fattura semplice, 10-15 per una tedesca a più righe; 8-25 ore al mese ogni 100 fatture; 1-3% di errori di battitura | [Invoox](https://invoox.io/blog/gestire-fatture-fornitori-esteri/) (vendor) |
| Le fatture si accumulano | restano in una casella finché il commercialista le chiede a fine trimestre: scadenze già passate | Invoox |
| Integrazione in ritardo | 2 € a fattura, max 400 €/mese (1 € e 200 € entro 15 giorni) | [Computis](https://www.computis.it/blog/sanzioni-autofattura-estera-in-ritardo/), [Fiscozen](https://www.fiscozen.it/guide/sanzioni-invio-fattura-estera-sdi/) |
| Integrazione omessa | 500-10.000 €; 5% (minimo 1.000 €) se l'acquisto non è neanche in contabilità. Esempio Computis: 13,33 € se in ritardo, 846,66 € se omessa | Computis, [Agenda Digitale](https://www.agendadigitale.eu/documenti/esperto-risponde/integrazione-td18-cosa-si-rischia-se-non-viene-trasmessa/) |
| VIES non controllato | se il fornitore non è sul VIES, l'IVA estera addebitata è difficile da recuperare | [Esperto IVA](https://www.espertoiva.it/approfondimenti/documenti-prova-reverse-charge-ue-extra-ue-agenzia-entrate) |
| Abbinamento a ordine e DDT | consegne parziali, differenze di prezzo o cambio, trasporto non in ordine: le cause tipiche delle eccezioni | [Loopfour](https://loopfour.ai/articles/what-causes-a-three-way-match-failure-between-po-receipt-and-invoice), [Ken from Finance](https://www.kenfromfinance.com/blog/po-matching-exceptions-handling) |
| Costo di una fattura | 12,88 $ manuale contro 2,78 $ automatizzata; ciclo 17,4 contro 3,1 giorni; mediana APQC 21,40 $ | [Lido](https://www.lido.app/blog/invoice-processing-cost-benchmarks), [Resolve](https://resolvepay.com/blog/13-statistics-that-quantify-cost-per-invoice-in-manual-vs-automated-flows) |
| Eccezioni e doppioni | 10-50 $ per eccezione; circa 2% di doppioni nelle fatture manuali | [Cleo AI](https://cleoai.tech/knowledge/what_are_the_best_practices_for_handling_three-way_match_exceptions_in_accounts_payable.php), Resolve |
| Frode IBAN | alert Polizia Postale primavera 2026; Vicenza 150.000 €, Bari 120.000 € su un IBAN di Bangkok. Con l'estero l'IBAN straniero "sembra normale" | [Cyberment](https://cyberment.it/cyber-attacchi/iban-swapping-truffa-conti-aziendali/), [La Milano](https://lamilano.it/vicenza/frode-da-150mila-euro-nel-vicentino-la-polizia-interviene-e-recupera-lintera-somma/) |

Il problema non sparisce presto: la fattura elettronica strutturata per gli scambi intra-UE
(ViDA, Peppol, EN 16931) è obbligatoria solo dal **1/7/2030**
([Forvis Mazars](https://www.forvismazars.com/it/it/servizi/tax/fatturazione-elettronica-e-vida),
[VATupdate](https://www.vatupdate.com/2024/11/22/e-bill-obligation-for-intra-eu-transactions-from-1-july-2030/)).

## Chi lo fa già, e cosa manca

- [Autofatturala](https://autofatturala.com/) e [AutoFattura Sprint](https://autofatturasprint.it/):
  estrazione dal PDF, VIES, cambio BCE, codice TD, invio allo SdI, promemoria prima del 15.
- Invoox: solo estrazione.

Nessuno dei due **abbina la fattura all'ordine e alla bolla**, che è il punto che ci ha indicato
Ariete ("capire a quale corrisponde"). Nessuno controlla l'IBAN contro l'anagrafica, smista le
eccezioni alla persona giusta o arriva fino al pagamento.

## Cosa fa Quadra

1. Legge la fattura estera (inglese, tedesco) come legge l'XML italiano. Nel prototipo è il testo
   del PDF (`data/samples/INV-hessler-2026-4471.txt`); IBAN e VAT ID li rilegge il codice da quel
   testo, non li prende dal modello. Il controllo VIES non c'è ancora: è il passo dopo.
2. `check_invoice` lo abbina a ordine e DDT con le stesse regole delle italiane: prezzi, quantità
   ricevute, IBAN contro l'anagrafica, doppioni. IVA 0 è giusta solo se il fornitore è estero.
3. `prepare_integration` calcola nel codice cosa serve al contabile: tipo di documento (TD18, TD17
   o bolletta doganale), imponibile, IVA da integrare al 22%, **scadenza del 15** a partire dalla
   data della mail, e apre il task a Contabilità con tutto pronto. Una seconda volta non fa niente.
4. L'invio allo SdI resta a una persona (o all'intermediario), come ogni cosa che esce dall'azienda.

## Fonti normative

- [Agenzia delle Entrate, guida alla compilazione FE ed esterometro v1.9](https://www.agenziaentrate.gov.it/portale/documents/20143/451259/Guida_compilazione-FE-Esterometro-V1.9_2024-03-05.pdf/67fe4c2d-1174-e8de-f1ee-cea77b7f5203)
- [PMI.it, fattura elettronica per operazioni estere](https://www.pmi.it/card/fattura-elettronica-per-operazioni-estere)
- [Fiscomania, termine di registrazione](https://fiscomania.com/termine-di-registrazione-fattura-estero/)
- [Fiscomania, importazioni di beni](https://fiscomania.com/importazioni-di-beni-registrazione-contabile/)
