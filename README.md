# REEL–7 · field player

REEL–7 is een muziekspeler in de stijl van een draagbare tape-/field-recorder. Je zet je eigen muziek erop (mp3 en andere formaten), en speelt die af met een draaibare reel, varispeed zoals bij tape, en een paar eenvoudige effecten. Het is een web-app (PWA) die je op Android als gewone app op je startscherm zet, en die daarna ook offline werkt.

> **Geen officiële app.** REEL–7 is een onafhankelijke hommage, geïnspireerd op hardware-recorders zoals de TP–7. Het is niet gemaakt door, verbonden met of goedgekeurd door Teenage Engineering, en gebruikt geen logo's, merknamen of productfoto's van hen.

## Wat zit erin

- **Eigen muziek laden**: meerdere bestanden tegelijk via de knop `tape` → `+ load`. Elk bestand wordt als kopie in de app bewaard (IndexedDB), dus je muziek blijft staan na herladen of herstarten, ook offline.
- **Tape (bibliotheek)**: titel en artiest (uit ID3-tags bij mp3, anders de bestandsnaam) en duur. Volgorde aanpassen door aan `≡` te slepen, één nummer wissen (`×`, twee keer tikken) of de hele tape wissen (`erase` → `sure?`).
- **Transport**: play/pauze (met korte tape-start/-stop), stop, vorige/volgende, zoeken door op de golfvorm te tikken of te slepen.
- **Reel / jog-wiel**: vinger op de reel = de tape stopt; draaien = scrubben; een zwiep laat hem uitlopen met traagheid. Loslaten en het speelt verder.
- **Varispeed**: schuif `speed` van 0,50× tot 2,00×. De toonhoogte gaat mee, zoals bij echte tape. Klikt vast op 1,00×; dubbeltik of `=1` zet hem terug.
- **Knoppen (effecten)**: `vol`, `lp · tone · hp` (links low-pass, rechts high-pass, midden vlak), `drive` (tape-saturatie), `echo`, `spring` (veerreverb) en `wow` (wow & flutter). Sleep omhoog/omlaag, dubbeltik = reset. `fx` zet alle effecten in één keer uit (bypass).
- **A–B-loop en cues**: `a–b` drie keer tikken: A zetten, B zetten (loop aan), wissen. `cue` zet een marker (max. 8 per nummer), ingedrukt houden wist ze; `‹ cue` / `cue ›` springen ertussen. Loops en cues worden per nummer bewaard.
- **Display**: tijdcode `uu:mm:ss.hh`, nummer, snelheid, golfvorm met cues/loop en L/R-niveaumeters.
- **Memo**: neemt met de microfoon een take op en zet die als `take 001`, `take 002`, … op de tape (als WAV).
- **Vergrendelscherm en koptelefoon**: play/pauze/volgende/vorige/zoeken werken via de mediabediening van Android (Media Session).
- **Offline**: de app zelf wordt door een service worker bewaard; je audio staat in IndexedDB.
- Staand en liggend: liggend lijkt de indeling op een horizontale recorder (reel rechts, display en knoppen links).
- Toetsenbord (optioneel): spatie = play, ←/→ = 5 s zoeken, shift+←/→ = vorig/volgend nummer, `[` `]` = snelheid, `l` = tape, `a` = a–b, `m` = cue.

## Ondersteunde formaten

mp3, wav, m4a/aac, ogg (vorbis), opus, flac en webm — alles wat de browser van je toestel kan decoderen. Chrome op Android speelt al deze formaten normaal af. Een bestand dat het toestel niet kan lezen, wordt overgeslagen met een melding op het display.

## Online (Android)

De app staat op https://iliasbousba21.github.io/tape07/ (gepubliceerd vanaf `main` via GitHub Actions).

Open die link in **Chrome** op je telefoon. Tik op het menu (drie puntjes) en kies **App installeren** of **Toevoegen aan startscherm**. Daarna kun je REEL–7 als gewone app openen en je eigen mp3's laden. De eerste keer is een internetverbinding nodig; daarna werkt de app zelf ook offline. Je muziek blijft in de app staan.

## Lokaal draaien

Vereist: Node.js 18 of nieuwer.

```bash
cd reel-7
npm install
npm run dev        # ontwikkelserver, ook bereikbaar op je wifi-netwerk
npm run build      # productieversie in dist/
npm run preview    # dist/ lokaal bekijken
```

`dist/` bevat alleen statische bestanden en kan op elke HTTPS-host gezet worden (bv. GitHub Pages, Netlify, Cloudflare Pages). De app werkt ook vanuit een submap.

`npm run icons` maakt de app-iconen opnieuw (vereist Python 3 met Pillow).

## Installeren op Android

1. Zet de map `dist/` op een **HTTPS**-adres (installeren en de service worker werken niet via gewone `http://`, behalve op `localhost`).
2. Open dat adres in **Chrome** op je Android-telefoon.
3. Tik op het menu `⋮` → **App installeren** (of **Toevoegen aan startscherm**).
4. Open REEL–7 vanaf je startscherm. Tik op `tape` → `+ load` en kies je muziek.

Tip: de eerste keer vraagt de app de browser om opslag permanent te houden, zodat Android je muziek niet zomaar opruimt.

## Lettertypes

De app gebruikt **Geist**, **Geist Mono** en **Geist Pixel** (SIL Open Font License), lokaal meegeleverd in `public/fonts/` (licentie: `public/fonts/OFL-Geist.txt`). Er worden geen fonts of scripts van externe servers geladen.

## Privacy

Geen accounts, geen tracking, geen analytics, geen server. Je muziek en opnames blijven op je toestel.

## Bekende beperkingen

- Varispeed werkt via de afspeelsnelheid van de browser; onder 0,5× of boven 2× is niet mogelijk, en heel snelle wijzigingen kunnen even kraken.
- Scrubben met de reel springt in kleine stapjes door het nummer (de browser kan niet achteruit afspelen), dus het klinkt niet als echte vinyl-scratch.
- Golfvormen worden op de achtergrond berekend; bij bestanden groter dan ±160 MB of formaten die de decoder niet aankan, toont het display een bewegende tapestrook in plaats van een golfvorm.
- Hoeveel muziek je kwijt kunt, hangt af van de vrije opslag op je toestel (de browser bepaalt de limiet).
- Er bestaat geen "audio wake lock" voor webapps; afspelen op de achtergrond werkt via de normale mediabediening. Tijdens een memo-opname houdt de app het scherm aan.
